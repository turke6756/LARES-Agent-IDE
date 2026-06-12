import React, { useEffect, useMemo } from 'react';
import type { PathType } from '../../../shared/types';
import { useFileContentCache, registerFreshContentHandler } from './useFileContentCache';
import { detectFileType, isEditableFileType } from './fileTypeUtils';
import FileContentRenderer from './FileContentRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import MilkdownEditor from './MilkdownEditor';
import SelectionSurface from '../selection/SelectionSurface';
import { useWysiwygBeta } from './wysiwygBeta';
import { sniffWysiwygCompatibility } from './markdownSplice';
import type { SniffReason, SniffResult } from './markdownSplice';
import { resolveContentView } from './contentViewMode';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';
import GeoTiffRenderer from './GeoTiffRenderer';
import ShapefileRenderer from './ShapefileRenderer';
import GeoPackageRenderer from './GeoPackageRenderer';
import { useDashboardStore } from '../../stores/dashboard-store';

interface Props {
  tabId: string;
  filePath: string;
  pathType: PathType;
}

const SNIFF_REASON_LABELS: Record<SniffReason, string> = {
  mdx: 'MDX is not supported',
  frontmatter: 'it has frontmatter',
  'raw-html': 'it contains raw HTML blocks',
  'too-large': 'it is too large',
  'parse-failure': 'it failed to parse',
};

export default function FileContentArea({ tabId, filePath, pathType }: Props) {
  const fileType = filePath ? detectFileType(filePath) : null;
  const isMarkdown = fileType === 'markdown';
  const editState = useDashboardStore((state) => state.tabEditState[tabId]);
  const wysiwygBeta = useWysiwygBeta();
  const setDraftContent = useDashboardStore((state) => state.setDraftContent);
  const saveTab = useDashboardStore((state) => state.saveTab);
  const reloadFromDisk = useDashboardStore((state) => state.reloadFromDisk);
  const dismissExternalChange = useDashboardStore((state) => state.dismissExternalChange);
  const enterWysiwygMode = useDashboardStore((state) => state.enterWysiwygMode);
  const enterSourceMode = useDashboardStore((state) => state.enterSourceMode);

  // Media + geospatial binary types are fetched via media:// protocol — skip text file reading entirely
  const isMediaType =
    fileType === 'image' ||
    fileType === 'pdf' ||
    fileType === 'geotiff' ||
    fileType === 'shapefile' ||
    fileType === 'geopackage';
  const { content, loading } = useFileContentCache(tabId, filePath, pathType, isMediaType);

  // §6.3 exclusion sniffing at the dispatch. Sniff the edit-session baseline
  // when one exists (what the WYSIWYG editor would load), else the cached
  // disk content. The rules live in markdownSplice — never reimplemented here.
  const sniffSource = !isMarkdown
    ? null
    : editState
      ? editState.originalContent
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
    wysiwygIsDefault: wysiwygBeta,
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
    return <PdfRenderer filePath={filePath} pathType={pathType} />;
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

  // External-change banner — shared by both non-view editor modes.
  const withExternalChangeBanner = (editor: React.ReactElement): React.ReactElement => {
    if (!editState?.externalChange) return editor;
    return (
      <div className="h-full flex flex-col bg-surface-0">
        <div className="shrink-0 px-3 py-2 bg-amber-900/30 border-b border-amber-700/50 text-[12px] font-sans text-amber-200 flex items-center justify-between gap-3">
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
        <div className="flex-1 min-h-0">
          {editor}
        </div>
      </div>
    );
  };

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
