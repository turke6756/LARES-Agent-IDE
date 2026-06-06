import React, { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, ViewUpdate, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { useThemeStore } from '../../stores/theme-store';
import { getTabScrollFraction, setTabScrollFraction } from './scrollMemory';

interface Props {
  initialContent: string;
  language: 'markdown' | 'text';
  saving?: boolean;
  error?: string | null;
  onChange: (content: string) => void;
  onSave: () => void;
  tabId?: string;
}

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
