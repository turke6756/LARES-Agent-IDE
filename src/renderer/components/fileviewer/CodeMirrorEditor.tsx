import React, { useEffect, useRef } from 'react';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, ViewUpdate, drawSelection, highlightActiveLine, Decoration, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useThemeStore } from '../../stores/theme-store';
import { getTabScrollFraction, setTabScrollFraction } from './scrollMemory';
import type { TabFocusRange } from '../../stores/dashboard-store';

interface Props {
  initialContent: string;
  language: 'markdown' | 'text';
  saving?: boolean;
  error?: string | null;
  onChange: (content: string) => void;
  onSave: () => void;
  tabId?: string;
  // WP4: when set, scroll this 1-based line span to center and flash a transient
  // highlight over it (used by the knowledge / optimizer "open at source span" jump).
  focusRange?: TabFocusRange;
}

// WP4 — a transient line highlight for the focused source span. Implemented as a
// StateField so the decoration survives view updates and clears via a null effect.
const setFocusHighlight = StateEffect.define<{ from: number; to: number } | null>();
const focusLineDeco = Decoration.line({ class: 'cm-knowledge-source-line' });
const focusHighlightField = StateField.define<DecorationSet>({
  create() { return Decoration.none; },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFocusHighlight)) continue;
      if (e.value === null) { next = Decoration.none; continue; }
      const ranges = [];
      const startLine = tr.state.doc.lineAt(e.value.from).number;
      const endLine = tr.state.doc.lineAt(e.value.to).number;
      for (let ln = startLine; ln <= endLine; ln++) {
        ranges.push(focusLineDeco.range(tr.state.doc.line(ln).from));
      }
      next = Decoration.set(ranges);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--color-surface-0)',
    color: 'var(--color-fg-primary)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
    lineHeight: '1.5',
  },
  '.cm-content': {
    padding: '12px 0',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-1)',
    color: 'var(--color-fg-muted)',
    borderRight: '1px solid var(--color-surface-3)',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(102, 204, 255, 0.10)',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'rgba(102, 204, 255, 0.10)',
    color: 'var(--color-fg-primary)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#66ccff',
    borderLeftWidth: '2px',
  },
  '.cm-focused .cm-cursor': {
    borderLeftColor: '#66ccff',
    borderLeftWidth: '2px',
  },
});

export default function CodeMirrorEditor({
  initialContent,
  language,
  saving,
  error,
  onChange,
  onSave,
  tabId,
  focusRange,
}: Props) {
  const theme = useThemeStore((state) => state.theme);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialContentRef = useRef(initialContent);
  const tabIdRef = useRef(tabId);

  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    tabIdRef.current = tabId;
  }, [onChange, onSave, tabId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      EditorView.lineWrapping,
      editorTheme,
      focusHighlightField,
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
      }),
    ];

    if (language === 'markdown') {
      extensions.push(markdown());
    }
    if (theme === 'dark') {
      extensions.push(oneDark);
    }

    const state = EditorState.create({
      doc: initialContentRef.current,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;

    // Place the cursor where the user was viewing in the rendered view, so
    // entering edit mode doesn't snap to the top of the file and the caret
    // makes it obvious where typing will land.
    const fraction = tabIdRef.current ? getTabScrollFraction(tabIdRef.current) : 0;
    const totalLines = view.state.doc.lines;
    const targetLine = fraction > 0
      ? Math.max(1, Math.min(totalLines, Math.round(totalLines * fraction)))
      : 1;
    const lineInfo = view.state.doc.line(targetLine);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
    });
    view.focus();

    // Keep the shared per-tab scroll memory in sync while editing, so
    // switching tabs and coming back (in either edit or view mode) restores
    // the same place. The scrollIntoView above gets the doc measured near the
    // target; the rAF then snaps to the exact remembered fraction.
    const scrollEl = view.scrollDOM;
    const handleScroll = () => {
      const tid = tabIdRef.current;
      if (!tid) return;
      const max = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (max <= 0) return;
      setTabScrollFraction(tid, scrollEl.scrollTop / max);
    };
    let restoreFrame = 0;
    if (fraction > 0) {
      restoreFrame = requestAnimationFrame(() => {
        const max = scrollEl.scrollHeight - scrollEl.clientHeight;
        if (max > 0) scrollEl.scrollTop = max * fraction;
        scrollEl.addEventListener('scroll', handleScroll);
      });
    } else {
      scrollEl.addEventListener('scroll', handleScroll);
    }

    return () => {
      cancelAnimationFrame(restoreFrame);
      scrollEl.removeEventListener('scroll', handleScroll);
      view.destroy();
      viewRef.current = null;
    };
  }, [language, theme]);

  // WP4 — react to a focus request (fresh nonce on each click). Scroll the span to
  // center and flash the line highlight, auto-clearing after ~2.5s. Scheduled via
  // rAF so it lands after the mount effect's scroll-memory restore.
  useEffect(() => {
    if (!focusRange) return;
    let clearTimer = 0;
    const raf = requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const start = Math.max(1, Math.min(doc.lines, focusRange.lineStart));
      const end = Math.max(start, Math.min(doc.lines, focusRange.lineEnd));
      const from = doc.line(start).from;
      const to = doc.line(end).to;
      view.dispatch({
        effects: [EditorView.scrollIntoView(from, { y: 'center' }), setFocusHighlight.of({ from, to })],
      });
      clearTimer = window.setTimeout(() => {
        const v = viewRef.current;
        if (v) v.dispatch({ effects: setFocusHighlight.of(null) });
      }, 2500);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(clearTimer);
    };
  }, [focusRange?.nonce]);

  return (
    <div className="h-full flex flex-col bg-surface-0">
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden" />
      {(saving || error) && (
        <div className="shrink-0 px-3 py-1 border-t border-surface-3 text-[12px] font-sans">
          {saving ? (
            <span className="text-gray-400">Saving...</span>
          ) : (
            <span className="text-accent-red">{error}</span>
          )}
        </div>
      )}
    </div>
  );
}
