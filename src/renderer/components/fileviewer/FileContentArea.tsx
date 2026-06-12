import React from 'react';
import type { PathType } from '../../../shared/types';
import { useFileContentCache } from './useFileContentCache';
import { detectFileType, isEditableFileType } from './fileTypeUtils';
import FileContentRenderer from './FileContentRenderer';
import CodeMirrorEditor from './CodeMirrorEditor';
import MilkdownEditor from './MilkdownEditor';
import { useWysiwygBeta } from './wysiwygBeta';
import { sniffWysiwygCompatibility } from './markdownSplice';
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

export default function FileContentArea({ tabId, filePath, pathType }: Props) {
  const fileType = filePath ? detectFileType(filePath) : null;
  const editState = useDashboardStore((state) => state.tabEditState[tabId]);
  const wysiwygBeta = useWysiwygBeta();
  const setDraftContent = useDashboardStore((state) => state.setDraftContent);
  const saveTab = useDashboardStore((state) => state.saveTab);
  const reloadFromDisk = useDashboardStore((state) => state.reloadFromDisk);
  const dismissExternalChange = useDashboardStore((state) => state.dismissExternalChange);

  // Media + geospatial binary types are fetched via media:// protocol — skip text file reading entirely
  const isMediaType =
    fileType === 'image' ||
    fileType === 'pdf' ||
    fileType === 'geotiff' ||
    fileType === 'shapefile' ||
    fileType === 'geopackage';
  const { content, loading } = useFileContentCache(tabId, filePath, pathType, isMediaType);

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

  if (
    editState?.mode === 'edit' &&
    isEditableFileType(filePath) &&
    !content.error
  ) {
    const editor = (
      <CodeMirrorEditor
        key={`${tabId}-${editState.reloadVersion ?? 0}`}
        tabId={tabId}
        initialContent={editState.draftContent}
        language={fileType === 'markdown' ? 'markdown' : 'text'}
        saving={editState.saving}
        error={editState.error}
        onChange={(draft) => setDraftContent(tabId, draft)}
        onSave={() => { void saveTab(tabId); }}
      />
    );
    if (!editState.externalChange) return editor;
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
  }

  const renderedContent = editState && !editState.dirty && !content.error
    ? editState.originalContent
    : content.content;

  // Phase 0 spike branch (WP0.3): "WYSIWYG (beta)" toggle swaps the markdown
  // view branch to the Crepe editor. Temporary seam — WP1-A replaces this
  // with the three-mode dispatch; sniffer routing already lives in
  // markdownSplice so incompatible docs stay on the old renderer.
  if (
    wysiwygBeta &&
    fileType === 'markdown' &&
    !content.error &&
    sniffWysiwygCompatibility(renderedContent, renderedContent.length, { filePath }).ok
  ) {
    return <MilkdownEditor key={`${tabId}:${filePath}`} content={renderedContent} />;
  }

  return (
    <FileContentRenderer
      tabId={tabId}
      content={renderedContent}
      filePath={filePath}
      pathType={pathType}
      error={content.error}
    />
  );
}
