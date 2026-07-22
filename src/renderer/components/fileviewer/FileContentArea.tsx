import React, { useEffect, useMemo, useRef } from 'react';
import type { PathType } from '../../../shared/types';
import { useFileContentCache, registerFreshContentHandler } from './useFileContentCache';
import { detectFileType, isEditableFileType } from './fileTypeUtils';
import FileContentRenderer from './FileContentRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import MilkdownEditor from './MilkdownEditor';
import SelectionSurface from '../selection/SelectionSurface';
import { sniffWysiwygCompatibility } from './markdownSplice';
import type { SniffResult } from './markdownSplice';
import { resolveContentView, SNIFF_REASON_LABELS } from './contentViewMode';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';
import GeoTiffRenderer from './GeoTiffRenderer';
import ShapefileRenderer from './ShapefileRenderer';
import GeoPackageRenderer from './GeoPackageRenderer';
import { useDashboardStore } from '../../stores/dashboard-store';
import { diag, diagBasename } from './editLossDiag';

interface Props {
  tabId: string;
  filePath: string;
  pathType: PathType;
}

export default function FileContentArea({ tabId, filePath, pathType }: Props) {
  const fileType = filePath ? detectFileType(filePath) : null;
  const isMarkdown = fileType === 'markdown';
  const editState = useDashboardStore((state) => state.tabEditState[tabId]);
  const setDraftContent = useDashboardStore((state) => state.setDraftContent);
  const saveTab = useDashboardStore((state) => state.saveTab);
  const reloadFromDisk = useDashboardStore((state) => state.reloadFromDisk);
  const dismissExternalChange = useDashboardStore((state) => state.dismissExternalChange);
  const enterWysiwygMode = useDashboardStore((state) => state.enterWysiwygMode);
  const enterSourceMode = useDashboardStore((state) => state.enterSourceMode);
  // WP4: a pending "open at source span" request carried on the tab.
  const focusRange = useDashboardStore((state) => state.openTabs.find((t) => t.id === tabId)?.focusRange);
  // Identity the PDF reader threads through for the Phase-3 comment seam.
  const pdfWorkspaceId = useDashboardStore((state) => state.openTabs.find((t) => t.id === tabId)?.workspaceId);
  const pdfRootDirectory = useDashboardStore((state) => state.openTabs.find((t) => t.id === tabId)?.rootDirectory);

  // Media + geospatial binary types are fetched via media:// protocol — skip text file reading entirely
  const isMediaType =
    fileType === 'image' ||
    fileType === 'pdf' ||
    fileType === 'geotiff' ||
    fileType === 'shapefile' ||
    fileType === 'geopackage';
  const { content: cachedContent, loading: cacheLoading } = useFileContentCache(
    tabId,
    filePath,
    pathType,
    isMediaType,
  );

  // useFileContentCache's state lives on this component instance, not on the
  // tab, and FileContentArea is reused (no `key`) across tab switches. So right
  // after a switch the hook momentarily returns the *previous* tab's bytes
  // before its effect reloads for the new file — the new content carries the
  // old path. Treat a path mismatch as "still loading" so nothing downstream
  // (the sniff, the WYSIWYG-entry effect below, or the renderer) ever sees
  // another tab's content. Without this guard, enterWysiwygMode() baked the
  // stale bytes into the new tab's edit session permanently (originalContent is
  // written once and never overwritten), which is why a second markdown tab
  // opened in WYSIWYG showed the first tab's text.
  const content = cachedContent && cachedContent.path === filePath ? cachedContent : null;
  const loading = cacheLoading || (!isMediaType && !!filePath && content === null);

  // §6.3 exclusion sniffing at the dispatch. Sniff exactly what the WYSIWYG
  // editor would mount (plan §1.4): the dirty draft when one exists (the
  // canvas initializes from it since Phase 1), else the edit-session baseline,
  // else the cached disk content. The rules live in markdownSplice — never
  // reimplemented here.
  const sniffSource = !isMarkdown
    ? null
    : editState
      ? editState.dirty
        ? editState.draftContent
        : editState.originalContent
      : content && !content.error
        ? content.content
        : null;
  const sniff = useMemo<SniffResult | null>(() => {
    if (sniffSource === null) return null;
    const sizeBytes = new TextEncoder().encode(sniffSource).length;
    return sniffWysiwygCompatibility(sniffSource, sizeBytes, { filePath });
  }, [sniffSource, filePath]);

  const resolved = resolveContentView({
    isMarkdown,
    isEditable: filePath ? isEditableFileType(filePath) : false,
    mode: editState?.mode,
    // Markdown tabs open in the rendered View (read-only preview) by default;
    // the user clicks "Edit" (WYSIWYG) or "Source" from the header to start
    // editing.
    wysiwygIsDefault: false,
    sniff,
  });

  // WYSIWYG mounts need tabEditState created *first* (plan §5: created on
  // mount, not on an "Edit" click, so saveTab has state to act on). The
  // editor component itself never creates it.
  const pendingWysiwygContent =
    resolved.kind === 'wysiwyg' && !editState && content && !content.error
      ? content.content
      : null;
  useEffect(() => {
    if (pendingWysiwygContent !== null) {
      enterWysiwygMode(tabId, pendingWysiwygContent);
    }
  }, [pendingWysiwygContent, enterWysiwygMode, tabId]);

  // WP4: span highlighting is only meaningful in the CodeMirror source view (not the
  // Milkdown WYSIWYG), so when a focus request asks for `source` on a markdown tab,
  // force source mode once the bytes are in. Non-source-mode requests are a no-op here.
  const wantSourceFocus =
    focusRange?.mode === 'source' && isMarkdown && !!content && !content.error &&
    (!editState || editState.mode !== 'source');
  useEffect(() => {
    if (wantSourceFocus && content && !content.error) {
      enterSourceMode(tabId, content.content);
    }
  }, [wantSourceFocus, content, enterSourceMode, tabId]);

  // DIAG(edit-loss): log-only transition tracker — renders nothing, changes no
  // tree shape; lives with the other hooks ABOVE the first early return so the
  // hook order is stable. Logs transitions of the inputs that decide whether
  // the editor subtree gets replaced (H1 discriminators).
  const diagPrevSnapshotRef = useRef<string | null>(null);
  useEffect(() => {
    const snapshot = JSON.stringify({
      kind: resolved.kind,
      externalChange: !!editState?.externalChange,
      mode: editState?.mode ?? null,
      reloadVersion: editState?.reloadVersion ?? 0,
      // The MilkdownEditor key string as computed at :234 (basename only).
      editorKey: `${tabId}:${diagBasename(filePath)}:${editState?.reloadVersion ?? 0}`,
    });
    if (diagPrevSnapshotRef.current === snapshot) return;
    diag('content-area-transition', {
      tabId,
      from: diagPrevSnapshotRef.current,
      to: snapshot,
    });
    diagPrevSnapshotRef.current = snapshot;
  });

  if (!filePath) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-400 font-sans text-sm  ">
          Select a file from the tree
        </div>
      </div>
    );
  }

  // Render media types directly — they don't need file content
  if (fileType === 'image') {
    return <ImageRenderer filePath={filePath} pathType={pathType} />;
  }
  if (fileType === 'pdf') {
    return (
      <PdfRenderer
        filePath={filePath}
        pathType={pathType}
        tabId={tabId}
        workspaceId={pdfWorkspaceId}
        rootDirectory={pdfRootDirectory}
      />
    );
  }
  if (fileType === 'geotiff') {
    return <GeoTiffRenderer filePath={filePath} />;
  }
  if (fileType === 'shapefile') {
    return <ShapefileRenderer filePath={filePath} />;
  }
  if (fileType === 'geopackage') {
    return <GeoPackageRenderer filePath={filePath} />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-300 font-sans text-sm animate-pulse">Loading file...</div>
      </div>
    );
  }

  if (!content) return null;

  // External-change banner — shared by both non-view editor modes. The
  // wrapper is ALWAYS mounted with one stable root element type and a keyed
  // editor slot; only the banner row toggles (plan §1.1, diagnosis H1).
  // Toggling externalChange must never change the tree shape around the
  // editor — a root-type flip would unmount/remount the whole editor subtree
  // mid-edit and revert the visible canvas.
  const withExternalChangeBanner = (editor: React.ReactElement): React.ReactElement => (
    <div className="h-full flex flex-col bg-surface-0">
      {editState?.externalChange ? (
        <div
          key="banner"
          className="shrink-0 px-3 py-2 bg-amber-900/30 border-b border-amber-700/50 text-[12px] font-sans text-amber-200 flex items-center justify-between gap-3"
        >
          <span>This file changed on disk{editState.dirty ? ' while you were editing' : ''}.</span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => reloadFromDisk(tabId)}
              className="ui-btn text-[12px]"
              title="Replace the editor contents with the version on disk"
            >
              Reload from disk
            </button>
            <button
              onClick={() => dismissExternalChange(tabId)}
              className="ui-btn text-[12px]"
              title="Keep editing — saving will overwrite the disk version"
            >
              Keep my changes
            </button>
          </div>
        </div>
      ) : null}
      <div key="editor" className="flex-1 min-h-0">
        {editor}
      </div>
    </div>
  );

  if (resolved.kind === 'source' && editState && !content.error) {
    return withExternalChangeBanner(
      <CodeMirrorEditor
        key={`${tabId}-${editState.reloadVersion ?? 0}`}
        tabId={tabId}
        initialContent={editState.draftContent}
        language={fileType === 'markdown' ? 'markdown' : 'text'}
        saving={editState.saving}
        error={editState.error}
        onChange={(draft) => setDraftContent(tabId, draft)}
        onSave={() => { void saveTab(tabId); }}
        focusRange={focusRange}
      />,
    );
  }

  if (resolved.kind === 'wysiwyg' && !content.error) {
    if (!editState) {
      // tabEditState lands on the next tick via the effect above.
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-gray-300 font-sans text-sm animate-pulse">Loading file...</div>
        </div>
      );
    }
    // WP1 props contract: tabId + filePath + content (original on-disk bytes,
    // the splice baseline) + the useFileContentCache registration seam.
    return withExternalChangeBanner(
      <SelectionSurface tabId={tabId}>
      <MilkdownEditor
        key={`${tabId}:${filePath}:${editState.reloadVersion ?? 0}`}
        tabId={tabId}
        filePath={filePath}
        content={editState.originalContent}
        registerFreshContentHandler={registerFreshContentHandler}
      />
      </SelectionSurface>,
    );
  }

  const renderedContent = editState && !editState.dirty && !content.error
    ? editState.originalContent
    : content.content;

  const renderer = (
    <FileContentRenderer
      tabId={tabId}
      content={renderedContent}
      filePath={filePath}
      pathType={pathType}
      error={content.error}
      warnings={content.warnings}
    />
  );

  // §6.3 exclusion routing: WYSIWYG was requested (or is the default) but the
  // doc is excluded — old renderer + notice + "View source".
  if (resolved.kind === 'view' && resolved.wysiwygBlockedReason && !content.error) {
    return (
      <div className="h-full flex flex-col bg-surface-0">
        <div className="shrink-0 px-3 py-2 bg-surface-2/60 border-b border-surface-3 text-[12px] font-sans text-gray-300 flex items-center justify-between gap-3">
          <span>
            WYSIWYG editing is unavailable for this document — {SNIFF_REASON_LABELS[resolved.wysiwygBlockedReason]}.
          </span>
          <button
            onClick={() => enterSourceMode(tabId, renderedContent)}
            className="ui-btn text-[12px] shrink-0"
            title="Edit the raw markdown source instead"
          >
            View source
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {renderer}
        </div>
      </div>
    );
  }

  return renderer;
}
