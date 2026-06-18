/**
 * Unit tests for the markdown link → internal-browser handler
 * (plans/markdown-url-open-in-internal-browser.md).
 *
 * Tests the React-free core `handleMarkdownUrlClick` + the `isHttpUrl`
 * predicate. The thin `useModifierUrlOpen` hook just wires this core to the
 * browser/dashboard stores, so the behavior worth pinning lives here:
 *  - modifier + http(s) → opens internal (prevents default, returns true)
 *  - plain click        → unchanged (returns false, no open, no preventDefault)
 *  - non-http href      → falls through (returns false) to file-path handling
 */
import { describe, expect, it, vi } from 'vitest';
import { handleMarkdownUrlClick, isHttpUrl } from './openFileHelpers';

type ClickEvent = Parameters<typeof handleMarkdownUrlClick>[0];

function fakeEvent(mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const preventDefault = vi.fn();
  const stopPropagation = vi.fn();
  const e: ClickEvent = {
    ctrlKey: mods.ctrlKey ?? false,
    metaKey: mods.metaKey ?? false,
    preventDefault,
    stopPropagation,
  };
  return { e, preventDefault, stopPropagation };
}

describe('isHttpUrl', () => {
  it('accepts http and https (case/space tolerant)', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com/path?x=1')).toBe(true);
    expect(isHttpUrl('  HTTPS://Example.com  ')).toBe(true);
  });

  it('rejects non-http schemes and bare paths', () => {
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('mailto:a@b.com')).toBe(false);
    expect(isHttpUrl('tab://abc')).toBe(false);
    expect(isHttpUrl('./docs/foo.md')).toBe(false);
    expect(isHttpUrl('src/main/index.ts')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('handleMarkdownUrlClick', () => {
  it('modifier + http(s) → opens internal, prevents default, returns true', () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
      const open = vi.fn();
      const { e, preventDefault, stopPropagation } = fakeEvent(mod);
      const handled = handleMarkdownUrlClick(e, ' https://hotels.example/book?dates=1-3 ', open);
      expect(handled).toBe(true);
      // Trimmed before opening so a stray-space href still navigates cleanly.
      expect(open).toHaveBeenCalledWith('https://hotels.example/book?dates=1-3');
      // preventDefault is what stops the shell externalizing the link instead.
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(stopPropagation).toHaveBeenCalledTimes(1);
    }
  });

  it('plain click on an http link → unchanged: no open, no preventDefault, false', () => {
    const open = vi.fn();
    const { e, preventDefault } = fakeEvent(); // no modifiers
    const handled = handleMarkdownUrlClick(e, 'https://example.com', open);
    expect(handled).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('modifier + non-http href → falls through (false), leaves it for file-path handling', () => {
    for (const href of ['./docs/foo.md', 'src/main/index.ts', 'mailto:a@b.com', 'file:///x']) {
      const open = vi.fn();
      const { e, preventDefault } = fakeEvent({ ctrlKey: true });
      const handled = handleMarkdownUrlClick(e, href, open);
      expect(handled).toBe(false);
      expect(open).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    }
  });

  it('missing href → false, no open', () => {
    const open = vi.fn();
    const { e } = fakeEvent({ ctrlKey: true });
    expect(handleMarkdownUrlClick(e, undefined, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
