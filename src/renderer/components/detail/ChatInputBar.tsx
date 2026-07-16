import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import type { Agent, AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';
import { useDashboardStore } from '../../stores/dashboard-store';
import { loadDraft, saveDraft } from '../../lib/chat-drafts';
import {
  formatAgentToken,
  detectMention,
  filterAgents,
  type MentionContext,
} from '../../lib/agent-mention';
import { getCaretCoordinates } from '../../lib/textarea-caret';
import AtMentionDropdown from './AtMentionDropdown';

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
  // Positioned ancestor for the absolutely-positioned mention dropdown; caret
  // coordinates are expressed relative to this wrapper (Slice D wire-up).
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ── "@"-mention autocomplete (Slice B) ──────────────────────────────────
  // Candidate source is the agents in the currently-selected workspace — the
  // same filter AgentPickerDropdown uses. Self is INCLUDED. No "visible agents"
  // selector exists; if one is added later, swap the source here only.
  const selectedWorkspaceId = useDashboardStore((s) => s.selectedWorkspaceId);
  const allAgents = useDashboardStore((s) => s.agents);
  const wsAgents = useMemo(
    () => allAgents.filter((a) => a.workspaceId === selectedWorkspaceId),
    [allAgents, selectedWorkspaceId],
  );
  const [mention, setMention] = useState<MentionContext | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const candidates = useMemo(
    () => (mention ? filterAgents(wsAgents, mention.query).slice(0, 8) : []),
    [mention, wsAgents],
  );
  // Clamp the highlight whenever the candidate list changes so
  // candidates[highlighted] can never be undefined after filtering narrows it.
  useEffect(() => {
    setHighlighted(0);
  }, [candidates]);
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

  // Re-run "@"-mention detection from the live caret. Called on input changes
  // AND on caret moves (keyup / click / select) so the menu opens/closes as the
  // caret crosses a mention. `mention` stays non-null even when `candidates` is
  // empty — that drives the no-match row; it clears only on detection-fail.
  const recomputeMention = useCallback((value: string, caret: number | null) => {
    const next = caret == null ? null : detectMention(value, caret);
    // Keep the SAME object reference when the detected mention is unchanged.
    // Caret syncs fire on every keyup/click/select — including while arrowing
    // through the dropdown — and a fresh object each time would churn the
    // `candidates` memo and re-trigger the highlight-clamp effect, wiping the
    // arrow selection. Only hand back a new object when query/atIndex move.
    setMention((prev) => {
      if (next == null) return prev == null ? prev : null;
      if (prev && prev.query === next.query && prev.atIndex === next.atIndex) return prev;
      return next;
    });
  }, []);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateInput(e.target.value);
    recomputeMention(e.target.value, e.target.selectionStart);
  }, [updateInput, recomputeMention]);

  const handleCaretSync = useCallback(() => {
    const ta = inputRef.current;
    if (!ta) return;
    recomputeMention(ta.value, ta.selectionStart);
  }, [recomputeMention]);

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

  // Replace the in-progress "@…" run with the agent's full token + a trailing
  // space, then drop the caret just past it. atIndex marks where the '@' began;
  // the caret marks where the typed query ended.
  const selectMention = useCallback((agent: Agent) => {
    if (!mention) return;
    const token = formatAgentToken(agent);
    const ta = inputRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const before = input.slice(0, mention.atIndex);
    const after = input.slice(caret);
    const insert = token + ' ';
    const next = before + insert + after;
    updateInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = (before + insert).length;
      ta?.focus();
      ta?.setSelectionRange(pos, pos);
    });
  }, [mention, input, updateInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Intercept BEFORE the Enter-sends branch: while the dropdown is open it
    // owns Enter/Tab/Arrow keys so we neither send nor move the caret.
    if (mention) {
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
      if (candidates.length === 0) {
        // No-match row visible: swallow nav + commit keys.
        if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          return;
        }
      } else {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlighted((h) => (h + 1) % candidates.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlighted((h) => (h - 1 + candidates.length) % candidates.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          selectMention(candidates[highlighted]);
          return;
        }
      }
    }
    // Reached only when mention === null (dropdown closed): normal send.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [mention, candidates, highlighted, selectMention, handleSend]);

  // Close the dropdown on blur, but defer one tick so a row's onMouseDown
  // (which keeps focus via preventDefault — Slice C) commits the pick first.
  const handleBlur = useCallback(() => {
    setTimeout(() => setMention(null), 0);
  }, []);

  // Caret coordinates for the dropdown anchor, from the LIVE selectionStart so
  // the menu follows the typed query and wraps with it. Expressed relative to
  // the wrapper (the dropdown's positioned ancestor): caret point + textarea
  // bounding rect − wrapper rect. The dropdown opens upward from here. On
  // NaN / throw, return null so the dropdown falls back to the corner anchor.
  const mentionPosition = useMemo<{ left: number; top: number; maxHeight: number } | null>(() => {
    if (!mention) return null;
    const ta = inputRef.current;
    const wrap = wrapperRef.current;
    if (!ta || !wrap) return null;
    try {
      const caret = ta.selectionStart ?? input.length;
      const coords = getCaretCoordinates(ta, caret);
      if (!coords || Number.isNaN(coords.top) || Number.isNaN(coords.left)) return null;
      const taRect = ta.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      const rawLeft = taRect.left + coords.left - wrapRect.left;
      const top = taRect.top + coords.top - wrapRect.top;
      if (Number.isNaN(rawLeft) || Number.isNaN(top)) return null;
      const pickerWidth = Math.min(280, Math.max(0, wrapRect.width - 16));
      const left = Math.max(8, Math.min(rawLeft, wrapRect.width - pickerWidth - 8));
      const caretViewportY = wrapRect.top + top;
      const maxHeight = Math.max(40, Math.min(240, caretViewportY - 8));
      return { left, top, maxHeight };
    } catch {
      return null;
    }
  }, [mention, input]);

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
        // Shared full-id token — same format as the "@"-mention path.
        token = formatAgentToken(a);
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
      ref={wrapperRef}
      className={`relative ${showDragHandle ? '' : 'border-t '}px-3 py-2 ${
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
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleCaretSync}
          onClick={handleCaretSync}
          onSelect={handleCaretSync}
          onBlur={handleBlur}
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
      {mention && (
        <AtMentionDropdown
          candidates={candidates}
          query={mention.query}
          highlighted={highlighted}
          onPick={selectMention}
          onHover={setHighlighted}
          position={mentionPosition}
        />
      )}
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
