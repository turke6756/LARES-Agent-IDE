import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import { useBrowserStore } from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── Reading mode (Slice 14 — the reader overlay) ──────────────────────────────
// A full-pane overlay shown when `readerArticle` is non-null. It renders the
// extracted + SANITIZED article (title, byline, html) in a distraction-free
// layout with reader controls: font size, serif/sans, light/sepia/dark theme,
// reading-time, and find-in-reader.
//
// SECURITY: `article.html` was DOMPurify-sanitized in main (scripts, on*
// handlers, javascript: URLs stripped) but is still UNTRUSTED render-only
// content. We inject it into OUR OWN renderer DOM via dangerouslySetInnerHTML —
// never re-granting script capability, never round-tripping it to an agent path.
//
// Because a WebContentsView paints ABOVE renderer DOM, this overlay occludes the
// live page region, so it SUSPENDS the pane (useBrowserSuspension) for its
// lifetime — only the inner component (which mounts solely while open) calls the
// hook, so the pane is restored on close (mirrors HistoryView / ActivityDrawer).

type ReaderTheme = 'light' | 'sepia' | 'dark';

const THEMES: Record<ReaderTheme, { bg: string; fg: string; muted: string; label: string }> = {
  light: { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b6b6b', label: 'Light' },
  sepia: { bg: '#f4ecd8', fg: '#5b4636', muted: '#8a7559', label: 'Sepia' },
  dark: { bg: '#1a1a1a', fg: '#e8e6e3', muted: '#9a9a9a', label: 'Dark' },
};

// Step sizes for the body text (px). The starting index is the comfortable
// default; −/＋ walk the array.
const FONT_SIZES = [15, 17, 19, 22, 26];
const DEFAULT_FONT_INDEX = 2;

/** Reading-time from the sanitized text length. ~5 chars/word, 200 wpm → a
 *  steady ~1000 chars/min; floor at "1 min read" for any non-empty article. */
function readingTimeLabel(textLength: number): string {
  const minutes = Math.max(1, Math.round(textLength / 1000));
  return `${minutes} min read`;
}

/** Remove any find-in-reader <mark> wrappers, restoring the original text. */
function clearHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark[data-reader-find]');
  marks.forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  });
}

/** Wrap every case-insensitive occurrence of `query` in the rendered article in
 *  a <mark data-reader-find>. Returns the match count. Walks text nodes only —
 *  the sanitized html has no scripts/styles to descend into. */
function applyHighlights(root: HTMLElement, query: string): number {
  clearHighlights(root);
  const q = query.trim();
  if (!q) return 0;
  const lower = q.toLowerCase();

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    if (value.toLowerCase().includes(lower)) targets.push(node as Text);
  }

  let count = 0;
  for (const text of targets) {
    const value = text.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let from = 0;
    let idx = value.toLowerCase().indexOf(lower, from);
    while (idx !== -1) {
      if (idx > from) frag.appendChild(document.createTextNode(value.slice(from, idx)));
      const mark = document.createElement('mark');
      mark.setAttribute('data-reader-find', '');
      mark.className = 'reader-find-hit';
      mark.textContent = value.slice(idx, idx + q.length);
      frag.appendChild(mark);
      count += 1;
      from = idx + q.length;
      idx = value.toLowerCase().indexOf(lower, from);
    }
    if (from < value.length) frag.appendChild(document.createTextNode(value.slice(from)));
    text.parentNode?.replaceChild(frag, text);
  }
  return count;
}

function ReadingModeViewInner() {
  // Suspends the WebContentsView while the reader is up (the overlay covers the
  // host area). REQUIRED Slice-14 behavior — exercised by the renderer test.
  useBrowserSuspension();

  const article = useBrowserStore((s) => s.readerArticle)!;
  const closeReadingMode = useBrowserStore((s) => s.closeReadingMode);

  const [theme, setTheme] = useState<ReaderTheme>('light');
  const [fontIndex, setFontIndex] = useState(DEFAULT_FONT_INDEX);
  const [serif, setSerif] = useState(true);
  const [find, setFind] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [matchCount, setMatchCount] = useState(0);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);

  const palette = THEMES[theme];
  const fontSize = FONT_SIZES[fontIndex];

  // Inject the SANITIZED, untrusted article html into our OWN DOM imperatively
  // (not via React's dangerouslySetInnerHTML) so the content div's children are
  // ours to mutate: a find-highlight pass adds <mark>s that a subsequent React
  // re-render (e.g. from setMatchCount) would otherwise clobber. innerHTML never
  // executes scripts, and the html carries none (DOMPurify stripped them in
  // main) — this never re-grants script capability or reaches an agent path.
  useEffect(() => {
    const root = contentRef.current;
    if (root) root.innerHTML = article.html;
  }, [article.html]);

  // Re-apply find highlights whenever the query (or the article) changes. Runs
  // after the inject effect above (effects fire in declaration order), so a
  // fresh article is highlighted against the newly-injected DOM.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    setMatchCount(applyHighlights(root, findOpen ? find : ''));
  }, [find, findOpen, article.html]);

  // Esc: close the find bar first if it's open, else exit the reader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (findOpen) {
          setFindOpen(false);
          setFind('');
        } else {
          closeReadingMode();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [findOpen, closeReadingMode]);

  // Focus the find input when the find bar opens.
  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  const readingTime = useMemo(() => readingTimeLabel(article.textLength), [article.textLength]);

  const canShrink = fontIndex > 0;
  const canGrow = fontIndex < FONT_SIZES.length - 1;

  return (
    <div
      className="browser-overlay-anim absolute inset-0 z-40 flex flex-col"
      style={{ backgroundColor: palette.bg, color: palette.fg }}
      data-reader-theme={theme}
    >
      {/* ── Reader toolbar (chrome strip above the article) ── */}
      <div
        className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0"
        style={{ borderColor: 'rgba(127,127,127,0.25)' }}
      >
        <div className="flex items-center gap-2 mr-1" style={{ color: palette.muted }}>
          <Icons.BookOpen className="w-4 h-4" />
          <span className="text-[12px] font-semibold uppercase tracking-wide">Reader</span>
        </div>

        <span className="text-[11px] tabular-nums" style={{ color: palette.muted }}>
          {readingTime}
        </span>

        <div className="flex-1" />

        {/* Font size −/＋ */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setFontIndex((i) => Math.max(0, i - 1))}
            disabled={!canShrink}
            className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
            title="Decrease font size"
            aria-label="Decrease font size"
          >
            <Icons.AArrowDown className="w-4 h-4" />
          </button>
          <button
            onClick={() => setFontIndex((i) => Math.min(FONT_SIZES.length - 1, i + 1))}
            disabled={!canGrow}
            className="ui-btn ui-btn-ghost p-1.5 disabled:opacity-30"
            title="Increase font size"
            aria-label="Increase font size"
          >
            <Icons.AArrowUp className="w-4 h-4" />
          </button>
        </div>

        {/* Serif / sans toggle */}
        <button
          onClick={() => setSerif((s) => !s)}
          className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] font-semibold"
          title={serif ? 'Switch to sans-serif' : 'Switch to serif'}
          aria-label="Toggle serif font"
          aria-pressed={serif}
        >
          {serif ? 'Serif' : 'Sans'}
        </button>

        {/* Theme switch: light / sepia / dark */}
        <div className="flex items-center gap-0.5">
          {(Object.keys(THEMES) as ReaderTheme[]).map((t) => (
            <button
              key={t}
              onClick={() => setTheme(t)}
              className="ui-btn ui-btn-ghost p-1.5"
              title={`${THEMES[t].label} theme`}
              aria-label={`${THEMES[t].label} theme`}
              aria-pressed={theme === t}
              style={{
                outline: theme === t ? '2px solid var(--color-accent-blue)' : 'none',
                outlineOffset: '1px',
              }}
            >
              <span
                className="w-3.5 h-3.5 rounded-full border border-black/20 inline-block"
                style={{ backgroundColor: THEMES[t].bg }}
              />
            </button>
          ))}
        </div>

        {/* Find-in-reader toggle */}
        <button
          onClick={() => setFindOpen((o) => !o)}
          className="ui-btn ui-btn-ghost p-1.5"
          title="Find in article (Ctrl+F)"
          aria-label="Find in article"
          aria-pressed={findOpen}
        >
          <Icons.Search className="w-4 h-4" />
        </button>

        {/* Close / exit reader */}
        <button
          onClick={() => closeReadingMode()}
          className="ui-btn ui-btn-ghost p-1.5"
          title="Exit reading mode"
          aria-label="Exit reading mode"
        >
          <Icons.X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Find-in-reader bar ── */}
      {findOpen && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 border-b shrink-0"
          style={{ borderColor: 'rgba(127,127,127,0.25)' }}
        >
          <Icons.Search className="w-3.5 h-3.5 shrink-0" style={{ color: palette.muted }} />
          <input
            ref={findInputRef}
            type="text"
            value={find}
            spellCheck={false}
            placeholder="Find in article"
            aria-label="Find in article"
            onChange={(e) => setFind(e.target.value)}
            className="flex-1 min-w-0 bg-transparent text-[12px] focus:outline-none"
            style={{ color: palette.fg }}
          />
          <span className="text-[11px] tabular-nums shrink-0" style={{ color: palette.muted }}>
            {find.trim() ? `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}` : ''}
          </span>
          <button
            onClick={() => {
              setFindOpen(false);
              setFind('');
            }}
            className="ui-btn ui-btn-ghost p-1"
            title="Close find"
            aria-label="Close find"
          >
            <Icons.X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Article body (scrollable, centered reading column) ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <article
          className="mx-auto px-6 py-10"
          style={{
            maxWidth: '720px',
            fontSize: `${fontSize}px`,
            lineHeight: 1.7,
            fontFamily: serif
              ? 'Georgia, Cambria, "Times New Roman", serif'
              : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          }}
        >
          <h1
            className="font-bold mb-2"
            style={{ fontSize: `${Math.round(fontSize * 1.7)}px`, lineHeight: 1.25 }}
          >
            {article.title || 'Untitled'}
          </h1>
          {article.byline && (
            <div className="mb-6 text-[0.85em] italic" style={{ color: palette.muted }}>
              {article.byline}
            </div>
          )}
          {/* UNTRUSTED, main-sanitized html is injected imperatively into this
              div by the effect above (never re-granted script capability; never
              sent to an agent path). */}
          <div ref={contentRef} className="reader-content" />
        </article>
      </div>
    </div>
  );
}

export default function ReadingModeView() {
  const article = useBrowserStore((s) => s.readerArticle);
  if (!article) return null;
  return <ReadingModeViewInner />;
}
