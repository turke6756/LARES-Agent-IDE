import React, { useState } from 'react';
import type { PathType } from '../../../shared/types';
import { detectFileType, detectLanguage, formatFileSize, isEditableFileType } from './fileTypeUtils';
import * as Icons from 'lucide-react';
import FileIcon from './FileIcon';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useWysiwygBeta, setWysiwygBetaEnabled } from './wysiwygBeta';

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
  const [enteringEdit, setEnteringEdit] = useState(false);
  const editState = useDashboardStore((state) => state.tabEditState[tabId]);
  const enterEditMode = useDashboardStore((state) => state.enterEditMode);
  const exitEditMode = useDashboardStore((state) => state.exitEditMode);
  const discardTabChanges = useDashboardStore((state) => state.discardTabChanges);
  const saveTab = useDashboardStore((state) => state.saveTab);
  const checkHealth = useDashboardStore((state) => state.checkHealth);
  const isEditing = editState?.mode === 'edit';
  const wysiwygBeta = useWysiwygBeta();
  const dirty = !!editState?.dirty;
  const saving = !!editState?.saving;
  const saveError = editState?.error;

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

  const handleEdit = async () => {
    if (!editable || enteringEdit) return;
    setEnteringEdit(true);
    try {
      const result = await window.api.files.readFile(filePath, pathType);
      if (result.error) {
        window.alert(result.error);
        return;
      }
      enterEditMode(tabId, result.content);
    } finally {
      if (pathType === 'wsl') {
        void checkHealth();
      }
      setEnteringEdit(false);
    }
  };

  const handleView = () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    if (dirty) {
      discardTabChanges(tabId);
    } else {
      exitEditMode(tabId);
    }
  };

  const handleSave = () => {
    void saveTab(tabId);
  };

  // Build breadcrumb paths
  const breadcrumbs = segments.map((seg, i) => {
    const path = '/' + segments.slice(0, i + 1).join('/');
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

        {fileType === 'markdown' && !isEditing && (
          <button
            onClick={() => setWysiwygBetaEnabled(!wysiwygBeta)}
            className={`ui-btn text-[13px] ${wysiwygBeta ? 'text-accent-blue' : ''}`}
            title="Phase 0 spike: render markdown in the Crepe WYSIWYG editor (view-only, nothing saves)"
          >
            <Icons.Sparkles className="w-3 h-3" />
            WYSIWYG (beta)
          </button>
        )}

        {editable && (
          <>
            {isEditing ? (
              <>
                <button
                  onClick={handleView}
                  className="ui-btn text-[13px]"
                >
                  <Icons.Eye className="w-3 h-3" />
                  View
                </button>
                <button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                  className="ui-btn ui-btn-primary text-[13px]"
                >
                  {saving ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.Save className="w-3 h-3" />}
                  Save
                </button>
              </>
            ) : (
              <button
                onClick={handleEdit}
                disabled={enteringEdit}
                className="ui-btn text-[13px]"
              >
                {enteringEdit ? <Icons.Loader2 className="w-3 h-3 animate-spin" /> : <Icons.Pencil className="w-3 h-3" />}
                Edit
              </button>
            )}
          </>
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
