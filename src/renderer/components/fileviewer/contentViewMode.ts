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

/**
 * User-facing copy for the §6.3 exclusion reasons — shared by the
 * content-area "WYSIWYG unavailable" notice and the header's dirty
 * source→wysiwyg carry gate (plan §1.4).
 */
export const SNIFF_REASON_LABELS: Record<SniffReason, string> = {
  mdx: 'MDX is not supported',
  frontmatter: 'it has frontmatter',
  'raw-html': 'it contains raw HTML blocks',
  'too-large': 'it is too large',
  'parse-failure': 'it failed to parse',
};

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
  /**
   * The wysiwyg edit session already OWNS the doc: it holds a live (dirty)
   * draft, so the sniff ran over the editor's own serialization, not over
   * entry content (disk bytes / a pristine baseline). Anti-eviction invariant
   * (edit-loss hotfix): such a session is never demoted by a failing sniff —
   * the sniff's job is gating ENTRY into wysiwyg, not policing a mounted
   * editor whose serializer artifacts it might misread as raw HTML.
   */
  sessionOwnsDoc: boolean;
}): ResolvedContentView {
  const { isMarkdown, isEditable, mode, wysiwygIsDefault, sniff, sessionOwnsDoc } = opts;

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
  // Anti-eviction: an active wysiwyg session with a live draft keeps the
  // editor mounted no matter what the draft sniffs as. Entry stays gated:
  // a session with no live draft (pristine — sniffing disk/baseline bytes)
  // or no session at all still routes through the sniff below.
  if (mode === 'wysiwyg' && sessionOwnsDoc) {
    return { kind: 'wysiwyg' };
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
