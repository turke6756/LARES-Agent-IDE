import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Icons from 'lucide-react';
import type { PathType } from '../../../shared/types';
import { contentHash } from '../fileviewer/markdownSplice';
import CodeMirrorEditor from '../fileviewer/CodeMirrorEditor';
import MarkdownRenderer from '../fileviewer/MarkdownRenderer';

interface Props {
  content: string;
  filePath: string;
  rootDirectory: string;
  pathType: PathType;
  workspaceId: string;
}

type Mode = 'view' | 'edit';

/**
 * Props-driven markdown surface for places that have a real file but no file
 * tab. It reuses the file viewer's editor, renderer, comment stack and file
 * IPC while keeping persistence keyed to the explicit path.
 */
export default function EmbeddedMarkdownDocument({
  content: initialContent,
  filePath,
  rootDirectory,
  pathType,
  workspaceId,
}: Props): React.ReactElement {
  const [content, setContent] = useState(initialContent);
  const [draft, setDraft] = useState(initialContent);
  const [mode, setMode] = useState<Mode>('view');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  const baselineRef = useRef(initialContent);
  const savingRef = useRef(false);

  draftRef.current = draft;

  useEffect(() => {
    let cancelled = false;
    setContent(initialContent);
    setDraft(initialContent);
    baselineRef.current = initialContent;
    setMode('view');
    setError(null);

    // planningReader content is intentionally bounded. Re-read through the
    // normal file IPC so edits always start from the complete disk document.
    const readFile = window.api.files?.readFile;
    if (readFile) {
      void readFile(filePath, pathType).then((result) => {
        if (cancelled || result.error) return;
        setContent(result.content);
        setDraft(result.content);
        baselineRef.current = result.content;
      });
    }
    return () => { cancelled = true; };
  }, [filePath, pathType, initialContent]);

  const persist = useCallback(async (next: string): Promise<boolean> => {
    if (savingRef.current || next === baselineRef.current) return true;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await window.api.files.writeFile(
        filePath,
        rootDirectory,
        pathType,
        next,
        contentHash(baselineRef.current),
      );
      if (!result.ok) {
        setError(result.conflict ? 'This file changed on disk. Reopen it before saving.' : result.error);
        return false;
      }
      baselineRef.current = next;
      setContent(next);
      return true;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [filePath, rootDirectory, pathType]);

  // File tabs save before close. A center-pane switch unmounts this surface,
  // so flush the latest synchronous CodeMirror draft through the same writer.
  useEffect(() => () => {
    const latest = draftRef.current;
    if (latest !== baselineRef.current) void persist(latest);
  }, [persist]);

  const showView = () => {
    if (draft !== baselineRef.current && !window.confirm('Discard unsaved changes?')) return;
    setDraft(baselineRef.current);
    setContent(baselineRef.current);
    setMode('view');
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0" data-testid="embedded-markdown-document">
      <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-white/10 px-3">
        <div className="flex items-center gap-0.5" role="group" aria-label="Markdown mode">
          <button type="button" onClick={showView} className={`ui-btn text-[12px] ${mode === 'view' ? 'text-accent-blue' : ''}`}>
            <Icons.Eye className="h-3 w-3" /> View
          </button>
          <button type="button" onClick={() => setMode('edit')} className={`ui-btn text-[12px] ${mode === 'edit' ? 'text-accent-blue' : ''}`} data-testid="proposal-edit">
            <Icons.Code className="h-3 w-3" /> Edit
          </button>
        </div>
        {mode === 'edit' && (
          <button
            type="button"
            onClick={() => { void persist(draftRef.current); }}
            disabled={saving}
            className={`ui-btn text-[12px] ${draft !== baselineRef.current ? 'ui-btn-primary' : ''}`}
            data-testid="proposal-save"
          >
            {saving ? <Icons.Loader2 className="h-3 w-3 animate-spin" /> : <Icons.Save className="h-3 w-3" />} Save
          </button>
        )}
        {error && <span className="ml-2 text-[11px] text-accent-red" role="alert">{error}</span>}
      </div>
      <div className="min-h-0 flex-1">
        {mode === 'edit' ? (
          <CodeMirrorEditor
            key={filePath}
            initialContent={draft}
            language="markdown"
            saving={saving}
            onChange={setDraft}
            onSave={() => { void persist(draftRef.current); }}
          />
        ) : (
          <MarkdownRenderer
            content={content}
            file={{ filePath, workspaceId, pathType, rootDirectory }}
          />
        )}
      </div>
    </div>
  );
}
