import React, { useState } from 'react';
import type { PathType } from '../../../shared/types';
import { detectFileType, detectLanguage, formatFileSize, isEditableFileType } from './fileTypeUtils';
import * as Icons from 'lucide-react';
import FileIcon from './FileIcon';
import { useDashboardStore } from '../../stores/dashboard-store';
import { SNIFF_REASON_LABELS, type TabMode } from './contentViewMode';
import { sniffWysiwygCompatibility } from './markdownSplice';
import { requestSave } from './saveCoordinator';

interface Props {
  tabId: string;
  filePath: string;
  pathType: PathType;
  fileSize: number;
  workingDirectory?: string;
  onNavigate: (dirPath: string) => void;
}

export default function FileViewerHeader({ tabId, filePath, pathType, fileSize, workingDirectory, onNavigate }: Props) {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const fileType = detectFileType(filePath);
  const language = fileType === 'code' ? detectLanguage(filePath) : fileType;
  const editable = isEditableFileType(filePath);
  const isMarkdown = fileType === 'markdown';
  const isDocx = fileType === 'docx';
  const [switchingMode, setSwitchingMode] = useState(false);
  const [convertingDocx, setConvertingDocx] = useState(false);
  const editState = useDashboardStore((state) => state.tabEditState[tabId]);
  const openTab = useDashboardStore((state) => state.openTab);
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const enterSourceMode = useDashboardStore((state) => state.enterSourceMode);
  const enterWysiwygMode = useDashboardStore((state) => state.enterWysiwygMode);
  const enterViewMode = useDashboardStore((state) => state.enterViewMode);
  const exitEditMode = useDashboardStore((state) => state.exitEditMode);
  const discardTabChanges = useDashboardStore((state) => state.discardTabChanges);
  const checkHealth = useDashboardStore((state) => state.checkHealth);
  const dirty = !!editState?.dirty;
  const saving = !!editState?.saving;
  const saveError = editState?.error;
  // Mode shown as active. Markdown tabs without an edit session display the
  // default rendered View; the user picks Edit (WYSIWYG) or Source to start
  // editing, which is when FileContentArea creates the real tabEditState.
  const mode: TabMode = editState?.mode ?? 'view';

  const handleOpenInVSCode = async () => {
    if (workingDirectory) {
      await window.api.system.openFileInWorkspace(filePath, workingDirectory, pathType);
    } else {
      await window.api.system.openFile(filePath, pathType);
    }
    if (pathType === 'wsl') {
      await checkHealth();
    }
  };

  const readFileFromDisk = async (): Promise<string | null> => {
    const result = await window.api.files.readFile(filePath, pathType);
    if (result.error) {
      window.alert(result.error);
      return null;
    }
    return result.content;
  };

  // Single mode-switch path for the three-state markdown control and the
  // legacy Edit/View buttons on other editable types. A dirty draft survives
  // BOTH directions between the two edit modes (D2, plan §1.4): CodeMirror
  // shows the spliced draft, and since Phase 1 the WYSIWYG canvas mounts from
  // the dirty draft too. Only a dirty switch to 'view' asks before
  // discarding. A source → wysiwyg carry must sniff THE DRAFT (what the
  // canvas would mount); an incompatible draft stays in source mode with an
  // explanation — never a prompt that can discard.
  const switchMode = async (target: TabMode) => {
    if (switchingMode || mode === target) return;
    if (!editable && target !== 'view') return;
    const carriesDraft =
      dirty &&
      ((mode === 'wysiwyg' && target === 'source') ||
        (mode === 'source' && target === 'wysiwyg'));
    if (dirty && !carriesDraft && !window.confirm('Discard unsaved changes?')) return;

    if (target === 'wysiwyg' && carriesDraft && editState) {
      const draft = editState.draftContent;
      const sniff = sniffWysiwygCompatibility(
        draft,
        new TextEncoder().encode(draft).length,
        { filePath },
      );
      if (!sniff.ok) {
        window.alert(
          `Can't open this draft in the WYSIWYG editor — ${SNIFF_REASON_LABELS[sniff.reason]}. ` +
            'Your unsaved changes are kept in Source mode.',
        );
        return;
      }
    }

    if (target === 'view') {
      if (dirty) {
        discardTabChanges(tabId); // also sets mode 'view'
      } else if (editState) {
        exitEditMode(tabId);
      } else {
        // No edit session yet (markdown default-WYSIWYG tab) — pin the
        // explicit view choice so it overrides the default.
        setSwitchingMode(true);
        try {
          const content = await readFileFromDisk();
          if (content !== null) enterViewMode(tabId, content);
        } finally {
          if (pathType === 'wsl') void checkHealth();
          setSwitchingMode(false);
        }
      }
      return;
    }

    if (dirty && !carriesDraft) discardTabChanges(tabId);
    setSwitchingMode(true);
    try {
      const content = await readFileFromDisk();
      if (content === null) return;
      if (target === 'source') {
        // enterSourceMode preserves a dirty draft (the wysiwyg → source carry).
        enterSourceMode(tabId, content);
      } else {
        // enterWysiwygMode also preserves a dirty draft (the source → wysiwyg
        // carry, sniffed above); the canvas mounts from it.
        enterWysiwygMode(tabId, content);
      }
    } finally {
      if (pathType === 'wsl') void checkHealth();
      setSwitchingMode(false);
    }
  };

  // Routed through the save coordinator (edit-loss Phase 2): requestSave
  // snapshots the live editor synchronously, so a canvas edit still inside
  // the ~200ms debounce window reaches disk; genuinely pristine ⇒ no write.
  const handleSave = () => {
    void requestSave(tabId);
  };

  const handleEditDocxAsMarkdown = async () => {
    if (!workingDirectory || convertingDocx) return;
    setConvertingDocx(true);
    try {
      const result = await window.api.files.convertDocxToMarkdown(filePath, workingDirectory, pathType);
      if (!result.ok || !result.path) {
        window.alert(result.ok ? 'Converted Markdown path was not returned.' : result.error);
        return;
      }
      openTab(result.path, workingDirectory, pathType, undefined, selectedWorkspaceId ?? undefined);
    } finally {
      if (pathType === 'wsl') void checkHealth();
      setConvertingDocx(false);
    }
  };

  // Build breadcrumb paths. The absolute prefix up to the workspace folder is
  // noise — show only the segments *after* the workspace root, keeping the full
  // path for navigation. Falls back to the full path when the file isn't under
  // the known workspace directory.
  const wdSegments = (workingDirectory ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  const underWorkspace =
    wdSegments.length > 0 &&
    segments.length > wdSegments.length &&
    segments.slice(0, wdSegments.length).join('/').toLowerCase() ===
      wdSegments.join('/').toLowerCase();
  const relStart = underWorkspace ? wdSegments.length : 0;
  const breadcrumbs = segments.slice(relStart).map((seg, i) => {
    const path = '/' + segments.slice(0, relStart + i + 1).join('/');
    return { label: seg, path };
  });

  const fileName = segments[segments.length - 1] ?? '';

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-surface-3 bg-surface-1 shrink-0">
      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 min-w-0 overflow-hidden flex-1">
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          const isFirst = i === 0;
          return (
            <React.Fragment key={i}>
              {i > 0 && <Icons.ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />}
              <div className="flex items-center gap-1.5 min-w-0">
                {isLast ? (
                  <>
                    <FileIcon name={fileName} className="w-3.5 h-3.5 shrink-0" />
                    <span className="text-gray-50 text-[13px] font-sans font-medium truncate">{crumb.label}</span>
                  </>
                ) : (
                  <>
                    {isFirst ? <FileIcon name={crumb.label} isDirectory className="w-3.5 h-3.5 shrink-0" /> : null}
                    <button
                      onClick={() => onNavigate(crumb.path)}
                      className="text-gray-300 hover:text-accent-blue text-[13px] font-sans truncate transition-colors shrink-0 max-w-[120px]"
                    >
                      {crumb.label}
                    </button>
                  </>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {/* Labels */}
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[11px] text-accent-blue px-1.5 py-0.5 bg-accent-blue/10">
          {language}
        </span>

        {fileSize > 0 && (
          <span className="text-[13px] font-sans text-gray-300 flex items-center gap-1">
            <Icons.Database className="w-3 h-3" />
            {formatFileSize(fileSize)}
          </span>
        )}

        {editable && isMarkdown && (
          <div className="flex items-center gap-0.5" role="group" aria-label="Markdown mode">
            <button
              onClick={() => { void switchMode('view'); }}
              className={`ui-btn text-[13px] ${mode === 'view' ? 'text-accent-blue' : ''}`}
              title="Rendered preview (read-only)"
            >
              <Icons.Eye className="w-3 h-3" />
              View
            </button>
            <button
              onClick={() => { void switchMode('wysiwyg'); }}
              disabled={switchingMode}
              className={`ui-btn text-[13px] ${mode === 'wysiwyg' ? 'text-accent-blue' : ''}`}
              title="Edit in the WYSIWYG canvas"
            >
              <Icons.PenLine className="w-3 h-3" />
              Edit
            </button>
            <button
              onClick={() => { void switchMode('source'); }}
              disabled={switchingMode}
              className={`ui-btn text-[13px] ${mode === 'source' ? 'text-accent-blue' : ''}`}
              title="Edit raw markdown source"
            >
              {switchingMode ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.Code className="w-3 h-3" />}
              Source
            </button>
          </div>
        )}

        {editable && !isMarkdown && (
          mode !== 'view' ? (
            <button
              onClick={() => { void switchMode('view'); }}
              className="ui-btn text-[13px]"
            >
              <Icons.Eye className="w-3 h-3" />
              View
            </button>
          ) : (
            <button
              onClick={() => { void switchMode('source'); }}
              disabled={switchingMode}
              className="ui-btn text-[13px]"
            >
              {switchingMode ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.Pencil className="w-3 h-3" />}
              Edit
            </button>
          )
        )}

        {editable && mode !== 'view' && (
          // Not gated on store `dirty`: it lags a live canvas edit by the
          // ~200ms markdownUpdated debounce (H4), so a dirty-gated button
          // could not save the visible doc. The coordinator snapshots the
          // live editor and no-ops when genuinely pristine. `dirty` still
          // drives the visual emphasis as the saved/unsaved affordance.
          <button
            onClick={handleSave}
            disabled={saving}
            className={`ui-btn text-[13px] ${dirty ? 'ui-btn-primary' : ''}`}
          >
            {saving ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.Save className="w-3 h-3" />}
            Save
          </button>
        )}

        {isDocx && (
          <button
            onClick={() => { void handleEditDocxAsMarkdown(); }}
            disabled={convertingDocx}
            className="ui-btn text-[13px]"
            title="Create a Markdown copy next to this Word document and open it for editing"
          >
            {convertingDocx ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.PenLine className="w-3 h-3" />}
            Edit as Markdown
          </button>
        )}

        {saveError && (
          <span className="text-[12px] text-accent-red max-w-[220px] truncate" title={saveError}>
            {saveError}
          </span>
        )}

        <button
          onClick={() => { void handleOpenInVSCode(); }}
          className="ui-btn text-[13px] text-accent-blue"
        >
          <Icons.ExternalLink className="w-3 h-3" />
          VS Code
        </button>
      </div>
    </div>
  );
}
