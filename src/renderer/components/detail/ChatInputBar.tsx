import React, { useState, useRef, useCallback, useEffect } from 'react';
import type { AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';
import { loadDraft, saveDraft } from '../../lib/chat-drafts';

const ACCEPTING_INPUT: AgentStatus[] = ['idle', 'waiting', 'done', 'crashed'];

export interface ChatInputBarProps {
  agentId: string;
  agentStatus: AgentStatus;
  // Staging mode: when true, render a drag handle inside the pill so the user
  // can drag the bar onto a note to swap, and skip the outer border so the bar
  // can sit cleanly inside the staging stack.
  showDragHandle?: boolean;
  onBarDragStart?: (e: React.DragEvent) => void;
  onBarDragEnd?: (e: React.DragEvent) => void;
  // Bumped by the staging container after a swap so the bar re-reads its
  // (now-changed) draft from localStorage without remounting (which would
  // lose focus).
  syncSignal?: number;
}

export default function ChatInputBar({
  agentId,
  agentStatus,
  showDragHandle = false,
  onBarDragStart,
  onBarDragEnd,
  syncSignal,
}: ChatInputBarProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [input, setInput] = useState<string>(() => loadDraft(agentId));
  const [sending, setSending] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastAgentIdRef = useRef(agentId);
  const lastSyncSignalRef = useRef(syncSignal);
  // The text of the most recent send, kept so an async delivery failure can
  // restore it into the box (see onSendInputError below).
  const lastSentRef = useRef<string>('');
  // Mirror of `input` readable synchronously inside the (agentId-scoped)
  // onSendInputError callback, which would otherwise close over a stale value.
  const inputValueRef = useRef(input);
  useEffect(() => {
    inputValueRef.current = input;
  }, [input]);

  // If the selected agent changes while this component stays mounted, swap to that agent's draft.
  useEffect(() => {
    if (lastAgentIdRef.current === agentId) return;
    lastAgentIdRef.current = agentId;
    setInput(loadDraft(agentId));
    setSendError(null);
  }, [agentId]);

  // When the staging container performs a swap, it writes the new value to
  // the draft and bumps syncSignal. Re-pull the draft and place the caret at
  // the end so the user can keep typing immediately.
  useEffect(() => {
    if (syncSignal === undefined) return;
    if (lastSyncSignalRef.current === syncSignal) return;
    lastSyncSignalRef.current = syncSignal;
    const next = loadDraft(agentId);
    setInput(next);
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.length, next.length);
    });
  }, [syncSignal, agentId]);

  // Async delivery failures (PTY closed mid-typing, runner removed, agent
  // mid auto-compact, etc.) arrive via this event channel because the IPC
  // handler is fire-and-forget for the multi-KB codex/gemini typing path
  // (see ipc-handlers.ts: 'agent:send-input' resolves as soon as delivery is
  // QUEUED). By the time the failure lands, handleSend has already cleared
  // the box optimistically — so restore the typed text here, otherwise the
  // user's message silently vanishes. Synchronous failures (status gate,
  // agent missing) come through the await rejection in handleSend, which
  // never clears the box in the first place.
  useEffect(() => {
    const unsubscribe = window.api.agents.onSendInputError(({ agentId: errAgent, error }) => {
      if (errAgent !== agentId) return;
      // Only restore if the box is empty — don't clobber a fresh draft the
      // user started typing after the (optimistically cleared) failed send.
      const failed = lastSentRef.current;
      if (failed && inputValueRef.current.trim().length === 0) {
        inputValueRef.current = failed; // reflect immediately for back-to-back errors
        setInput(failed);
        saveDraft(agentId, failed);
      }
      setSendError(error);
    });
    return unsubscribe;
  }, [agentId]);

  const updateInput = useCallback((next: string) => {
    setInput(next);
    saveDraft(agentId, next);
    if (sendError) setSendError(null);
  }, [agentId, sendError]);

  const canSend = ACCEPTING_INPUT.includes(agentStatus) && input.trim().length > 0 && !sending;
  const isDisabled = !ACCEPTING_INPUT.includes(agentStatus);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !canSend) return;

    setSending(true);
    setSendError(null);
    lastSentRef.current = text; // remembered so onSendInputError can restore it
    try {
      await window.api.agents.sendInput(agentId, text);
      updateInput('');
    } catch (err) {
      // Preserve the message in the input so the user can retry. The IPC
      // handler rejects here for the status gate and missing-agent cases.
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [agentId, input, canSend, updateInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    if (
      types.includes('application/x-agent-card') ||
      types.includes('application/x-file-path') ||
      types.includes('text/plain')
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!isDragOver) setIsDragOver(true);
    }
  }, [isDragOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear when leaving the drop zone entirely, not when crossing child boundaries
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    // Agent cards carry a dedicated payload (set in AgentCard.tsx). Insert an
    // identity token so the receiving agent knows it's a dashboard agent.
    let token: string;
    const agentPayload = e.dataTransfer.getData('application/x-agent-card');
    if (agentPayload) {
      try {
        const a = JSON.parse(agentPayload) as { id: string; title: string };
        token = `[dashboard agent "${a.title}" #${a.id.substring(0, 6)}]`;
      } catch {
        token = `@${agentPayload}`;
      }
    } else {
      const path =
        e.dataTransfer.getData('application/x-file-path') ||
        e.dataTransfer.getData('text/plain');
      if (!path) return;
      // Format as @path — readable in prose and visually distinct.
      token = `@${path}`;
    }

    const ta = inputRef.current;
    const prev = input;
    let next: string;
    if (ta && document.activeElement === ta) {
      const start = ta.selectionStart ?? prev.length;
      const end = ta.selectionEnd ?? prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
      const insert = `${needsLeadingSpace ? ' ' : ''}${token}${needsTrailingSpace ? ' ' : ' '}`;
      next = before + insert + after;
      // Restore caret after the inserted token
      requestAnimationFrame(() => {
        const caret = (before + insert).length;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    } else {
      const sep = prev.length === 0 || /\s$/.test(prev) ? '' : ' ';
      next = `${prev}${sep}${token} `;
      requestAnimationFrame(() => {
        ta?.focus();
        const caret = next.length;
        ta?.setSelectionRange(caret, caret);
      });
    }
    updateInput(next);
  }, [input, updateInput]);

  const statusHint = isDragOver
    ? 'Drop to attach file path…'
    : isDisabled
      ? agentStatus === 'working' || agentStatus === 'launching'
        ? 'Agent is working…'
        : `Agent is ${agentStatus}`
      : 'Message the agent…';

  return (
    <div
      className={`${showDragHandle ? '' : 'border-t '}px-3 py-2 ${
        isLight ? 'border-[#d0d7de] bg-[#f6f8fa]' : 'border-gray-800/40 bg-surface-1/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={`flex items-end gap-2 border rounded-full px-3 py-1.5 transition-colors ${
          isDragOver
            ? 'border-[var(--color-accent-blue)] shadow-[0_0_0_3px_rgba(0,122,204,0.2)] bg-[var(--color-accent-blue)]/5'
            : isDisabled
              ? 'border-surface-3 opacity-60'
              : isLight
                ? 'border-[#d0d7de] bg-white focus-within:border-[var(--color-accent-blue)] focus-within:shadow-[0_0_0_3px_rgba(0,122,204,0.1)]'
                : 'border-gray-800 bg-[#0d1117] focus-within:border-[var(--color-accent-blue)] focus-within:shadow-[0_0_0_3px_rgba(0,122,204,0.15)]'
        }`}
      >
        {showDragHandle && (
          <span
            draggable
            onDragStart={onBarDragStart}
            onDragEnd={onBarDragEnd}
            title="Drag onto a note to swap"
            aria-label="Drag prompt onto a note to swap"
            className={`shrink-0 self-center select-none cursor-grab active:cursor-grabbing text-[14px] leading-none px-1 ${
              isLight ? 'text-[#8b949e] hover:text-[#1a1a1a]' : 'text-gray-500 hover:text-gray-200'
            }`}
          >
            {'⋮⋮'}
          </span>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => updateInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isDisabled}
          placeholder={statusHint}
          rows={1}
          className={`flex-1 bg-transparent text-[13px] resize-none outline-none min-h-[22px] max-h-[160px] leading-relaxed disabled:cursor-not-allowed ${
            isLight ? 'text-[#1a1a1a] placeholder-[#8b949e]' : 'text-gray-50 placeholder-gray-500'
          }`}
          style={{ fieldSizing: 'content' } as React.CSSProperties}
        />
        <button
          onClick={handleSend}
          disabled={!canSend}
          className="ui-btn ui-btn-primary text-[11px] font-semibold uppercase tracking-wider px-3 py-1 min-h-0 shrink-0 rounded-full"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {sendError ? (
        <div className="flex items-start gap-1.5 mt-1.5 px-2">
          <span className="inline-block w-1.5 h-1.5 mt-1.5 rounded-full bg-[var(--color-accent-red)] shrink-0" />
          <span className="text-[11px] text-[var(--color-accent-red)] leading-snug break-words">
            Send failed: {sendError}
          </span>
          <button
            onClick={() => setSendError(null)}
            className="ml-auto text-[10px] uppercase tracking-wider text-gray-500 hover:text-gray-300 shrink-0"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      ) : isDisabled && (agentStatus === 'working' || agentStatus === 'launching') ? (
        <div className="flex items-center gap-1.5 mt-1.5 px-2">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent-yellow)] animate-pulse" />
          <span
            className={`text-[10px] uppercase tracking-wider font-semibold ${
              isLight ? 'text-[#57606a]' : 'text-gray-500'
            }`}
          >
            {agentStatus === 'launching' ? 'Initializing' : 'Thinking…'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
