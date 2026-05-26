import React from 'react';
import { detectFileType, detectLanguage, isInteractiveNotebookFile } from './fileTypeUtils';
import PlainTextRenderer from './PlainTextRenderer';
import CodeRenderer from './CodeRenderer';
import MarkdownRenderer from './MarkdownRenderer';
import CsvRenderer from './CsvRenderer';
import GeoTiffRenderer from './GeoTiffRenderer';
import ShapefileRenderer from './ShapefileRenderer';
import GeoPackageRenderer from './GeoPackageRenderer';
import ImageRenderer from './ImageRenderer';
import PdfRenderer from './PdfRenderer';
import NotebookRenderer from './NotebookRenderer';
import { NotebookView } from '../notebook/NotebookView';
import type { PathType } from '../../../shared/types';

interface Props {
  content: string;
  filePath: string;
  pathType: PathType;
  error?: string;
  tabId?: string;
}

export default function FileContentRenderer({ content, filePath, pathType, error, tabId }: Props) {
  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <div className="text-3xl mb-4 ">&#x26A0;</div>
          <div className="text-gray-400 font-sans text-sm mb-2">{error}</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="mt-4 px-4 py-2 text-[13px] font-sans   text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open in VS Code
          </button>
        </div>
      </div>
    );
  }

  const fileType = detectFileType(filePath);

  if (fileType === 'binary') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center p-8">
          <div className="text-3xl mb-4 ">&#x1F4E6;</div>
          <div className="text-gray-400 font-sans text-sm mb-2">Binary file — cannot display inline</div>
          <button
            onClick={() => window.api.system.openFile(filePath, pathType)}
            className="mt-4 px-4 py-2 text-[13px] font-sans   text-accent-blue border border-accent-blue/30 hover:bg-accent-blue/10 transition-colors"
          >
            Open in VS Code
          </button>
        </div>
      </div>
    );
  }

  if (fileType === 'markdown') {
    return <MarkdownRenderer content={content} tabId={tabId} />;
  }

  if (fileType === 'csv') {
    return <CsvRenderer content={content} filePath={filePath} />;
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

  if (fileType === 'code') {
    const language = detectLanguage(filePath);
    return <CodeRenderer content={content} language={language} />;
  }

  if (fileType === 'image') {
    return <ImageRenderer filePath={filePath} pathType={pathType} />;
  }

  if (fileType === 'pdf') {
    return <PdfRenderer filePath={filePath} pathType={pathType} />;
  }

  if (fileType === 'notebook') {
    if (isInteractiveNotebookFile(filePath)) {
      return <NotebookView path={filePath} />;
    }
    return (
      <div className="flex flex-col h-full">
        <div className="px-4 py-2 bg-amber-900/20 border-b border-amber-700/30 text-xs text-amber-300 font-sans">
          Non-standard notebook extension detected. Rendering statically; interactive run support currently expects `.ipynb`.
        </div>
        <div className="flex-1 min-h-0">
          <NotebookRenderer content={content} />
        </div>
      </div>
    );
  }

  return <PlainTextRenderer content={content} />;
}
