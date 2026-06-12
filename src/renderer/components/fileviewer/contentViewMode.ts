/**
 * Pure mode-dispatch model for the file viewer (WP1-A, plan §5).
 *
 * Decides which branch FileContentArea renders for a tab: rendered view,
 * CodeMirror source editor, or the Milkdown WYSIWYG canvas. §6.3 exclusion
 * routing happens here via the `sniff` input — the result of
 * `sniffWysiwygCompatibility()` from markdownSplice; this module never
 * reimplements the exclusion rules.
 *
 * Kept free of React/DOM imports so the dispatch is unit-testable without
 * mounting the (heavy) content-area component tree.
 */
import type { SniffReason, SniffResult } from './markdownSplice';

export type TabMode = 'view' | 'wysiwyg' | 'source';

export type ResolvedContentView =
  | { kind: 'view'; wysiwygBlockedReason?: SniffReason }
  | { kind: 'source' }
  | { kind: 'wysiwyg' };

export function resolveContentView(opts: {
  /** detectFileType(filePath) === 'markdown' */
  isMarkdown: boolean;
  /** isEditableFileType(filePath) */
  isEditable: boolean;
  /** tabEditState mode, if an edit session exists for the tab */
  mode: TabMode | undefined;
  /** beta flag: markdown tabs default to WYSIWYG when set */
  wysiwygIsDefault: boolean;
  /** sniffWysiwygCompatibility() result; null = not markdown / nothing to sniff */
  sniff: SniffResult | null;
}): ResolvedContentView {
  const { isMarkdown, isEditable, mode, wysiwygIsDefault, sniff } = opts;

  if (mode === 'source') {
    return isEditable ? { kind: 'source' } : { kind: 'view' };
  }
  if (!isMarkdown || !isEditable || mode === 'view') {
    return { kind: 'view' };
  }

  // Markdown with no explicit mode choice follows the default; an explicit
  // 'wysiwyg' choice is honored regardless of the default flag.
  const desired = mode ?? (wysiwygIsDefault ? 'wysiwyg' : 'view');
  if (desired !== 'wysiwyg') {
    return { kind: 'view' };
  }
  if (sniff?.ok) {
    return { kind: 'wysiwyg' };
  }
  // Excluded from WYSIWYG (§6.3): stay on the rendered view and surface why,
  // so the dispatch can offer "View source" instead.
  return {
    kind: 'view',
    wysiwygBlockedReason: sniff && !sniff.ok ? sniff.reason : 'parse-failure',
  };
}
