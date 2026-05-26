// localStorage-backed prompt-staging state, keyed by agent id.
//
// The "prompt staging" panel is the larger composer that replaces the chat
// input bar when toggled on. It holds an ordered stack of notes interleaved
// with the chat bar at some position. Dragging the bar onto a note swaps
// their text — the note's text fills the bar and the bar's old text becomes
// a note in the slot the bar vacated.
//
// The bar's CURRENT TEXT continues to live in chat-drafts.ts so the existing
// send/draft plumbing is untouched. This module persists only the slot
// arrangement and the open/closed toggle.

const KEY_PREFIX = 'prompt-staging:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NoteSlot { kind: 'note'; id: string; text: string; }
export interface BarSlot  { kind: 'bar'; }
export type Slot = NoteSlot | BarSlot;

export interface StagingState {
  slots: Slot[];
  open: boolean;
}

interface StagingRecord extends StagingState {
  v: 1;
  updatedAt: number;
}

const stagingKey = (id: string) => `${KEY_PREFIX}${id}`;

export function defaultStagingState(): StagingState {
  return { slots: [{ kind: 'bar' }], open: false };
}

export function newNoteId(): string {
  return `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isValidSlots(slots: unknown): slots is Slot[] {
  if (!Array.isArray(slots)) return false;
  let bars = 0;
  for (const s of slots) {
    if (!s || typeof s !== 'object') return false;
    const kind = (s as { kind?: unknown }).kind;
    if (kind === 'bar') {
      bars++;
    } else if (kind === 'note') {
      const n = s as Partial<NoteSlot>;
      if (typeof n.id !== 'string' || typeof n.text !== 'string') return false;
    } else {
      return false;
    }
  }
  return bars === 1;
}

export function loadStaging(id: string): StagingState {
  try {
    const raw = localStorage.getItem(stagingKey(id));
    if (!raw) return defaultStagingState();
    const parsed = JSON.parse(raw) as StagingRecord;
    if (!isValidSlots(parsed.slots)) return defaultStagingState();
    return { slots: parsed.slots, open: Boolean(parsed.open) };
  } catch {
    return defaultStagingState();
  }
}

export function saveStaging(id: string, state: StagingState): void {
  try {
    const rec: StagingRecord = { v: 1, slots: state.slots, open: state.open, updatedAt: Date.now() };
    localStorage.setItem(stagingKey(id), JSON.stringify(rec));
  } catch { /* ignore */ }
}

export function clearStaging(id: string): void {
  try { localStorage.removeItem(stagingKey(id)); } catch { /* ignore */ }
}

export function sweepStaleStaging(ttlMs: number = TTL_MS): void {
  try {
    const cutoff = Date.now() - ttlMs;
    const toDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as StagingRecord;
        if (typeof parsed.updatedAt !== 'number' || parsed.updatedAt < cutoff) {
          toDelete.push(key);
        }
      } catch {
        toDelete.push(key);
      }
    }
    for (const k of toDelete) localStorage.removeItem(k);
  } catch { /* ignore */ }
}
