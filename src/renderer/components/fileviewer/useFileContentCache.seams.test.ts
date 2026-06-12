/**
 * WP1-A tests for the two useFileContentCache seams added in Phase 1:
 * the write-generation token (recent-writes map, plan §5) and the
 * registerFreshContentHandler registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consultFreshContentHandler,
  isRecentWriteEcho,
  recordRecentWrite,
  registerFreshContentHandler,
} from './useFileContentCache';

describe('recent-writes map (write-generation token)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches a write recorded for the same tab and content', () => {
    recordRecentWrite('tab-rw-1', 'hello\nworld\n');
    expect(isRecentWriteEcho('tab-rw-1', 'hello\nworld\n')).toBe(true);
  });

  it('does not match different content or a different tab', () => {
    recordRecentWrite('tab-rw-2', 'content A');
    expect(isRecentWriteEcho('tab-rw-2', 'content B')).toBe(false);
    expect(isRecentWriteEcho('tab-rw-other', 'content A')).toBe(false);
  });

  it('keeps several rapid writes for the same tab alive at once', () => {
    recordRecentWrite('tab-rw-3', 'save one');
    vi.advanceTimersByTime(1_000);
    recordRecentWrite('tab-rw-3', 'save two');
    expect(isRecentWriteEcho('tab-rw-3', 'save one')).toBe(true);
    expect(isRecentWriteEcho('tab-rw-3', 'save two')).toBe(true);
  });

  it('expires entries after the TTL', () => {
    recordRecentWrite('tab-rw-4', 'ephemeral');
    vi.advanceTimersByTime(9_000);
    expect(isRecentWriteEcho('tab-rw-4', 'ephemeral')).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isRecentWriteEcho('tab-rw-4', 'ephemeral')).toBe(false);
  });
});

describe('registerFreshContentHandler registry', () => {
  it('returns null when no handler is registered', () => {
    expect(consultFreshContentHandler('tab-h-none', 'fresh')).toBeNull();
  });

  it('routes fresh content to the registered handler and returns its verdict', () => {
    const handler = vi.fn().mockReturnValue('conflict' as const);
    const dispose = registerFreshContentHandler('tab-h-1', handler);
    expect(consultFreshContentHandler('tab-h-1', 'fresh bytes')).toBe('conflict');
    expect(handler).toHaveBeenCalledWith('fresh bytes');
    dispose();
    expect(consultFreshContentHandler('tab-h-1', 'fresh bytes')).toBeNull();
  });

  it('supports all three verdicts', () => {
    for (const verdict of ['handled', 'conflict', 'fallback'] as const) {
      const dispose = registerFreshContentHandler('tab-h-2', () => verdict);
      expect(consultFreshContentHandler('tab-h-2', 'x')).toBe(verdict);
      dispose();
    }
  });

  it('re-registration replaces the handler; a stale disposer is a no-op', () => {
    const disposeOld = registerFreshContentHandler('tab-h-3', () => 'conflict');
    const disposeNew = registerFreshContentHandler('tab-h-3', () => 'fallback');
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBe('fallback');
    // Disposing the superseded registration must not remove the new handler
    // (remount races: old cleanup can run after the new mount registered).
    disposeOld();
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBe('fallback');
    disposeNew();
    expect(consultFreshContentHandler('tab-h-3', 'x')).toBeNull();
  });
});
