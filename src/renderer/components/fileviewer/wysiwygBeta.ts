/**
 * "WYSIWYG (beta)" spike toggle (plan §7 Phase 0). localStorage-backed,
 * default OFF. Tiny external store so FileViewerHeader (the toggle) and
 * FileContentArea (the view branch) stay in sync without store wiring —
 * WP1-A replaces this with the real three-mode model.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'fileviewer.wysiwygBeta';

const listeners = new Set<() => void>();

export function isWysiwygBetaEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setWysiwygBetaEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // localStorage unavailable — toggle just won't persist
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWysiwygBeta(): boolean {
  return useSyncExternalStore(subscribe, isWysiwygBetaEnabled);
}
