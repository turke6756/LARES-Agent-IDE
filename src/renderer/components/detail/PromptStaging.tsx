import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { AgentStatus } from '../../../shared/types';
import { useThemeStore } from '../../stores/theme-store';
import {
  loadStaging,
  saveStaging,
  newNoteId,
  type StagingState,
  type NoteSlot,
} from '../../lib/prompt-staging';
import { loadDraft, saveDraft } from '../../lib/chat-drafts';
import ChatInputBar from './ChatInputBar';

// Custom MIME used by the bar's drag handle so note rows can distinguish a
// bar-swap drag from the existing file-path drag-and-drop (which uses
// application/x-file-path and text/plain).
const BAR_DRAG_MIME = 'application/x-prompt-staging-bar';

interface Props {
  agentId: string;
  agentStatus: AgentStatus;
}

export default function PromptStaging({ agentId, agentStatus }: Props) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const [state, setState] = useState<StagingState>(() => loadStaging(agentId));
  const [barSyncSignal, setBarSyncSignal] = useState(0);
  const [pendingFocusNoteId, setPendingFocusNoteId] = useState<string | null>(null);
  const lastAgentIdRef = useRef(agentId);

  // Swap state when the selected agent changes mid-mount.
  useEffect(() => {
    if (lastAgentIdRef.current === agentId) return;
    lastAgentIdRef.current = agentId;
    setState(loadStaging(agentId));
    setBarSyncSignal((n) => n + 1);
  }, [agentId]);

  // Persist on every change.
  useEffect(() => {
    saveStaging(agentId, state);
  }, [agentId, state]);

  // Keep at least one note slot present so the "Add a note…" stub is always
  // visible as the affordance — there's no separate empty-state placeholder.
  useEffect(() => {
    if (state.slots.some((s) => s.kind === 'note')) return;
    setState((cur) => ({
      ...cur,
      slots: [...cur.slots, { kind: 'note', id: newNoteId(), text: '' }],
    }));
  }, [state.slots]);

  const updateNote = useCallback((id: string, text: string) => {
    setState((cur) => ({
      ...cur,
      slots: cur.slots.map((s) =>
        s.kind === 'note' && s.id === id ? { ...s, text } : s,
      ),
    }));
  }, []);

  const addNoteAtBottom = useCallback(() => {
    const id = newNoteId();
    setState((cur) => ({
      ...cur,
      slots: [...cur.slots, { kind: 'note', id, text: '' }],
    }));
    setPendingFocusNoteId(id);
  }, []);

  const deleteNote = useCallback((id: string) => {
    setState((cur) => {
      const next = cur.slots.filter(
        (s) => !(s.kind === 'note' && s.id === id),
      );
      // Always keep one note slot so the empty stub stays mounted.
      if (!next.some((s) => s.kind === 'note')) {
        next.push({ kind: 'note', id: newNoteId(), text: '' });
      }
      return { ...cur, slots: next };
    });
  }, []);

  // Swap the bar with the note at targetIdx. The bar physically moves to the
  // dropped-on slot; its prior text becomes a new note in the slot it just
  // vacated. The bar's text is persisted via the existing chat-drafts module
  // so ChatInputBar can pick up the new value via the syncSignal effect.
  const swapBarWithNoteAt = useCallback((targetIdx: number) => {
    setState((cur) => {
      const barIdx = cur.slots.findIndex((s) => s.kind === 'bar');
      if (barIdx === -1 || barIdx === targetIdx) return cur;
      const target = cur.slots[targetIdx];
      if (target.kind !== 'note') return cur;
      const barText = loadDraft(agentId);
      const newSlots = [...cur.slots];
      newSlots[barIdx] = { kind: 'note', id: newNoteId(), text: barText };
      newSlots[targetIdx] = { kind: 'bar' };
      saveDraft(agentId, target.text);
      return { ...cur, slots: newSlots };
    });
    setBarSyncSignal((n) => n + 1);
  }, [agentId]);

  const handleBarDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData(BAR_DRAG_MIME, '1');
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  return (
    <div
      className={`flex flex-col gap-1.5 px-3 py-2 border-t max-h-[60%] overflow-y-auto ${
        isLight
          ? 'border-[#d0d7de] bg-[#f6f8fa]'
          : 'border-gray-800/40 bg-surface-1/50'
      }`}
    >
      {state.slots.map((slot, idx) => {
        if (slot.kind === 'bar') {
          return (
            <ChatInputBar
              key="bar"
              agentId={agentId}
              agentStatus={agentStatus}
              showDragHandle
              onBarDragStart={handleBarDragStart}
              syncSignal={barSyncSignal}
            />
          );
        }
        return (
          <NoteRow
            key={slot.id}
            note={slot}
            onChange={(text) => updateNote(slot.id, text)}
            onDelete={() => deleteNote(slot.id)}
            onSwapWithBar={() => swapBarWithNoteAt(idx)}
            autoFocus={pendingFocusNoteId === slot.id}
            onAutoFocused={() => setPendingFocusNoteId(null)}
          />
        );
      })}
      <button
        type="button"
        onClick={addNoteAtBottom}
        className={`self-end ui-btn ui-btn-ghost text-[11px] uppercase tracking-wider px-2 py-1 min-h-0 ${
          isLight ? 'text-[#57606a]' : 'text-gray-400'
        }`}
        aria-label="Add note"
      >
        + Add note
      </button>
    </div>
  );
}

interface NoteRowProps {
  note: NoteSlot;
  onChange: (text: string) => void;
  onDelete: () => void;
  onSwapWithBar: () => void;
  autoFocus: boolean;
  onAutoFocused: () => void;
}

function NoteRow({
  note,
  onChange,
  onDelete,
  onSwapWithBar,
  autoFocus,
  onAutoFocused,
}: NoteRowProps) {
  const isLight = useThemeStore((s) => s.theme) === 'light';
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    if (!autoFocus) return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    onAutoFocused();
  }, [autoFocus, onAutoFocused]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(BAR_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!isDropTarget) setIsDropTarget(true);
  }, [isDropTarget]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDropTarget(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(BAR_DRAG_MIME)) return;
    e.preventDefault();
    setIsDropTarget(false);
    onSwapWithBar();
  }, [onSwapWithBar]);

  const expanded = focused;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`flex items-stretch gap-2 border rounded-2xl px-3 py-1 transition-all ${
        isDropTarget
          ? 'border-[var(--color-accent-blue)] bg-[var(--color-accent-blue)]/10 shadow-[0_0_0_3px_rgba(0,122,204,0.15)]'
          : focused
            ? isLight
              ? 'border-[var(--color-accent-blue)] bg-white shadow-[0_0_0_3px_rgba(0,122,204,0.1)]'
              : 'border-[var(--color-accent-blue)] bg-[#0d1117] shadow-[0_0_0_3px_rgba(0,122,204,0.15)]'
            : isLight
              ? 'border-[#e1e4e8] bg-[#fafbfc]'
              : 'border-gray-800/60 bg-[#0d1117]/70'
      }`}
    >
      <span
        className={`shrink-0 self-center text-[9px] font-semibold uppercase tracking-wider ${
          isLight ? 'text-[#8b949e]' : 'text-gray-500'
        }`}
      >
        Note
      </span>
      <textarea
        ref={taRef}
        value={note.text}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Add a note…"
        rows={1}
        className={`flex-1 bg-transparent text-[12px] resize-none outline-none leading-relaxed ${
          isLight ? 'text-[#1a1a1a] placeholder-[#8b949e]' : 'text-gray-50 placeholder-gray-500'
        } ${expanded ? 'max-h-[180px] min-h-[20px]' : 'max-h-[22px] min-h-[20px] overflow-hidden'}`}
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
      {note.text.length > 0 && focused && (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onDelete}
          aria-label="Delete note"
          className={`shrink-0 self-center text-[14px] leading-none px-1 ${
            isLight ? 'text-[#8b949e] hover:text-[var(--color-accent-red)]' : 'text-gray-500 hover:text-[var(--color-accent-red)]'
          }`}
        >
          {'×'}
        </button>
      )}
    </div>
  );
}
