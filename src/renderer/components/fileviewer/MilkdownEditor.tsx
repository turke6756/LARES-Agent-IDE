/**
 * Crepe WYSIWYG editor — WP1-B: editor + save fidelity (plan §5–§6,
 * docs/MARKDOWN_CANVAS_TASKS.md ## WP1-B).
 *
 * Imperative mount on purpose (control + isolation; see plan §3 constraint 2):
 * the Crepe instance lives entirely inside useLayoutEffect, with destroy()
 * cleanup and a create-then-destroy sequencing guard so StrictMode's
 * mount → unmount → mount cycle never destroys an instance mid-create.
 *
 * Store wiring (props contract with WP1-A): this component only ever calls
 * `setDraftContent` / `saveTab`, the way CodeMirrorEditor's callbacks do. It
 * NEVER creates `tabEditState` (WP1-A's `enterWysiwygMode` does, before
 * rendering this component) and never imports `useFileContentCache`
 * internals — fresh-content coordination arrives via the
 * `registerFreshContentHandler` prop seam.
 *
 * Dirty discipline (plan §5): no per-keystroke `setDraftContent` streaming —
 * Crepe's normalization would mark pristine docs dirty. Dirty is tracked
 * internally as `crepe.getMarkdown() !== loadSerialized` (baseline captured
 * after create); only when semantically dirty is the splice computed against
 * the original bytes and pushed as the draft.
 *
 * Event propagation (plan §6.2 seam for the app-wide selection primitive):
 * this component must not preventDefault()/stopPropagation() `contextmenu`,
 * `mouseup`, or selection events at its root — the only root listener is a
 * Ctrl+S keydown.
 */
import React, { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { Crepe } from '@milkdown/crepe';
import { editorViewCtx } from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
import type { EditorView } from '@milkdown/kit/prose/view';
import '@milkdown/crepe/theme/common/style.css';
// Theme-aware palette (light + dark) keyed off the app's <html> theme class,
// instead of the single prebuilt frame-dark theme that rendered black in light
// mode. See milkdownTheme.css.
import './milkdownTheme.css';
import { useDashboardStore } from '../../stores/dashboard-store';
import FileCommentGutter from '../selection/FileCommentGutter';
import { getTabScrollFraction, setTabScrollFraction } from './scrollMemory';
import {
  prepareSpliceBaseline,
  spliceMarkdown,
  getSpliceFallbackCount,
  onSpliceFallback,
  type SpliceBaseline,
} from './markdownSplice';

// ---------------------------------------------------------------------------
// Fresh-content seam (WP1-A owns the registry in useFileContentCache; this
// side only needs the structural shape of the prop).
// ---------------------------------------------------------------------------

export type FreshContentResult = 'handled' | 'conflict' | 'fallback';
export type FreshContentHandler = (freshContent: string) => FreshContentResult;
export type RegisterFreshContentHandler = (
  tabId: string,
  handler: FreshContentHandler,
) => (() => void) | void;

// ---------------------------------------------------------------------------
// Editor handle registry (WP1-B task 7) — seam for the app-wide selection
// primitive (plans/selection-to-agent-primitive-plan.md §6.1). The handle is
// a deliberately small interface, NOT the raw Crepe instance; widen the
// interface later without changing the registration pattern (mirrors the
// registerFreshContentHandler precedent).
// ---------------------------------------------------------------------------

export interface CanvasEditorHandle {
  getMarkdown(): string;
  getEditorView?(): EditorView | undefined;
}

const editorHandles = new Map<string, CanvasEditorHandle>();

export function getCanvasEditorHandle(tabId: string): CanvasEditorHandle | undefined {
  return editorHandles.get(tabId);
}

// ---------------------------------------------------------------------------
// Splice-failure containment surface (WP1-B task 3) — every whole-doc
// fallback logs with its running count, and the counter is reachable from
// the dev-tools console. This counter gates the default-on rollout.
// ---------------------------------------------------------------------------

onSpliceFallback((reason) => {
  console.warn(
    `[markdown-canvas] splice fallback (${reason}) — whole-doc write; ` +
      `total this session: ${getSpliceFallbackCount()}`,
  );
});
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__markdownCanvasSpliceFallbackCount =
    getSpliceFallbackCount;
}

// ---------------------------------------------------------------------------
// Image URL resolution (WP1-B task 6) — render-time only, via Crepe's
// proxyDomURL: the markdown itself keeps the author's original path.
// ---------------------------------------------------------------------------

function isAbsoluteFsPath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function docDirOf(docPath: string): string {
  const i = Math.max(docPath.lastIndexOf('/'), docPath.lastIndexOf('\\'));
  return i > 0 ? docPath.slice(0, i) : docPath;
}

function joinDocRelative(docPath: string, rel: string): string {
  const dir = docDirOf(docPath);
  const sep = dir.includes('\\') ? '\\' : '/';
  const parts = dir.split(/[\\/]/).filter((s, i) => s !== '' || i === 0);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join(sep);
}

/**
 * Map a markdown image URL to something the renderer can fetch: real URLs
 * (http:, https:, data:, media://, file:, protocol-relative) pass through;
 * filesystem paths — relative ones resolved against the doc's directory —
 * become `media://file/<encodedPath>` (same scheme as ImageRenderer).
 * Exported for unit tests.
 */
export function resolveImageUrl(url: string, docPath: string): string {
  if (!url || url.startsWith('#')) return url;
  // Scheme needs 2+ chars before the colon: `D:\shot.png` is a drive path.
  if (/^[a-z][a-z0-9+.-]+:/i.test(url) || url.startsWith('//')) return url;
  let path = url;
  try {
    path = decodeURIComponent(url);
  } catch {
    // malformed escapes — use the raw string
  }
  const abs = isAbsoluteFsPath(path) ? path : joinDocRelative(docPath, path);
  return `media://file/${encodeURIComponent(abs)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  tabId: string;
  filePath: string;
  /** Original on-disk bytes (pre-EOL-normalization) — the splice baseline. */
  content: string;
  /** WP1-A seam (useFileContentCache); read once at mount. */
  registerFreshContentHandler?: RegisterFreshContentHandler;
}

// Live instance accounting — exported for the leak unit test only.
let activeInstances = 0;
export function getActiveCrepeInstanceCount(): number {
  return activeInstances;
}

function normalizeEolLocal(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function MilkdownEditor({ tabId, filePath, content, registerFreshContentHandler }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const setDraftContent = useDashboardStore((s) => s.setDraftContent);
  const saveTab = useDashboardStore((s) => s.saveTab);

  // Refs keep the mount effect's dep list down to identity (tabId/filePath):
  // store actions, the registration seam, and the content prop must be
  // readable from inside the effect without remounting the editor.
  const setDraftContentRef = useRef(setDraftContent);
  const saveTabRef = useRef(saveTab);
  const registerRef = useRef(registerFreshContentHandler);
  const contentRef = useRef(content);
  useEffect(() => {
    setDraftContentRef.current = setDraftContent;
    saveTabRef.current = saveTab;
    registerRef.current = registerFreshContentHandler;
  }, [setDraftContent, saveTab, registerFreshContentHandler]);

  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const baselineRef = useRef<SpliceBaseline | null>(null);
  /** Crepe's own serialization of the last loaded/saved state — the dirty baseline. */
  const loadSerializedRef = useRef('');
  const dirtyRef = useRef(false);
  /** Set by the mount effect; lets the content-sync effect reach the live instance. */
  const applyFreshContentRef = useRef<((fresh: string) => void) | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    readyRef.current = false;
    dirtyRef.current = false;

    // Splice baseline from the ORIGINAL bytes; the editor itself receives the
    // LF-normalized text (plan §6.1).
    let baseline: SpliceBaseline | null = null;
    try {
      baseline = prepareSpliceBaseline(contentRef.current);
    } catch (err) {
      // sniffWysiwygCompatibility should have routed this doc away before we
      // mounted; degrade to whole-doc save semantics rather than refusing.
      console.error(
        '[MilkdownEditor] splice baseline failed — saves will be whole-doc',
        err,
      );
    }
    baselineRef.current = baseline;

    const crepe = new Crepe({
      root: container,
      defaultValue: baseline ? baseline.editorContent : normalizeEolLocal(contentRef.current),
      features: {
        // explicit since the Gate 2 KaTeX/Vite font probe; on by default in 7.21.2
        [Crepe.Feature.Latex]: true,
      },
      featureConfigs: {
        [Crepe.Feature.ImageBlock]: {
          proxyDomURL: (url: string) => resolveImageUrl(url, filePath),
        },
      },
    });
    crepeRef.current = crepe;
    activeInstances += 1;

    /** Splice the editor state against the original bytes and push it as the
     * store draft. Returns the draft that was pushed. */
    const pushSplicedDraft = (markdown: string): string => {
      const b = baselineRef.current;
      // Degraded path (baseline prep failed at mount): whole-doc, LF.
      const draft = b ? spliceMarkdown(b, markdown).content : markdown;
      setDraftContentRef.current(tabId, draft);
      return draft;
    };

    /** Dirty iff Crepe's serialization differs from the load/save baseline
     * (plan §5) — only then does the store hear about a draft. */
    const syncDirtyState = (markdown: string) => {
      if (!readyRef.current || disposed) return;
      if (markdown === loadSerializedRef.current) {
        if (dirtyRef.current) {
          dirtyRef.current = false;
          // Back to pristine (e.g. undo): draft = original bytes, so the
          // store's dirty flag agrees.
          setDraftContentRef.current(
            tabId,
            baselineRef.current?.originalContent ?? markdown,
          );
        }
        return;
      }
      dirtyRef.current = true;
      pushSplicedDraft(markdown);
    };

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        syncDirtyState(markdown);
      });
    });

    /** Explicit save only (WP1-B task 2): flush the splice synchronously —
     * the markdownUpdated listener is debounced 200ms and may lag a keystroke
     * — then saveTab. On success, rebaseline on the bytes just written so the
     * next edit splices against the new on-disk truth and the watcher echo of
     * our own write matches the new baseline. */
    const performSave = () => {
      if (!readyRef.current || disposed) return;
      const markdown = crepe.getMarkdown();
      if (markdown === loadSerializedRef.current) {
        if (dirtyRef.current) syncDirtyState(markdown);
        return; // pristine — nothing to write
      }
      dirtyRef.current = true;
      const draft = pushSplicedDraft(markdown);
      void saveTabRef.current(tabId).then((ok) => {
        if (!ok || disposed) return;
        try {
          baselineRef.current = prepareSpliceBaseline(draft);
        } catch (err) {
          console.error('[MilkdownEditor] rebaseline after save failed', err);
        }
        loadSerializedRef.current = markdown;
        dirtyRef.current = crepe.getMarkdown() !== markdown;
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        performSave();
      }
    };
    container.addEventListener('keydown', onKeyDown);

    // Per-tab scroll memory (shared with the source + view renderers via
    // scrollMemory). The editor remounts on every tab switch (the key includes
    // tabId), so without this the canvas snaps to the top each time you leave
    // and return. Record on scroll; restore happens after create() lays the
    // doc out (scrollHeight isn't final until then — see the create() chain).
    const recordScroll = () => {
      if (!tabId) return;
      const max = container.scrollHeight - container.clientHeight;
      if (max <= 0) return;
      setTabScrollFraction(tabId, container.scrollTop / max);
    };
    container.addEventListener('scroll', recordScroll, { passive: true });
    let restoreFrame = 0;

    // Editor handle registry (task 7).
    const handle: CanvasEditorHandle = {
      getMarkdown: () => crepe.getMarkdown(),
      getEditorView: () => {
        try {
          return crepe.editor.ctx.get(editorViewCtx);
        } catch {
          return undefined;
        }
      },
    };
    if (tabId) editorHandles.set(tabId, handle);

    // Fresh-content seam (task 4): 'conflict' while dirty (WP1-A surfaces the
    // banner), 'fallback' when clean (cache does the default content swap;
    // the new bytes come back around via the content prop and the sync effect
    // below refreshes the baseline). Phase 3 upgrades this to applying a
    // ProseMirror transaction and returning 'handled'.
    const unregister = tabId
      ? registerRef.current?.(tabId, () => (dirtyRef.current ? 'conflict' : 'fallback'))
      : undefined;

    /** Clean-editor content swap + baseline refresh (plan §5 'fallback'). */
    const applyFreshContent = (fresh: string) => {
      if (disposed || !readyRef.current || dirtyRef.current) return;
      if (fresh === baselineRef.current?.originalContent) return;
      try {
        const next = prepareSpliceBaseline(fresh);
        crepe.editor.action(replaceAll(next.editorContent, true));
        baselineRef.current = next;
        loadSerializedRef.current = crepe.getMarkdown();
        dirtyRef.current = false;
      } catch (err) {
        console.error('[MilkdownEditor] failed to apply fresh content', err);
      }
    };
    applyFreshContentRef.current = applyFreshContent;

    const created = crepe
      .create()
      .then(() => {
        if (disposed) return null;
        loadSerializedRef.current = crepe.getMarkdown();
        readyRef.current = true;
        // Content prop may have moved while create() was in flight.
        applyFreshContent(contentRef.current);
        // Restore the remembered scroll position now that the doc is laid out.
        // rAF lets layout settle so scrollHeight reflects the full document.
        const fraction = tabId ? getTabScrollFraction(tabId) : 0;
        if (fraction > 0) {
          restoreFrame = requestAnimationFrame(() => {
            if (disposed) return;
            const max = container.scrollHeight - container.clientHeight;
            if (max > 0) container.scrollTop = max * fraction;
          });
        }
        return crepe;
      })
      .catch((err: unknown) => {
        console.error('[MilkdownEditor] crepe.create() failed', err);
        return null;
      });

    return () => {
      disposed = true;
      readyRef.current = false;
      if (applyFreshContentRef.current === applyFreshContent) {
        applyFreshContentRef.current = null;
      }
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('scroll', recordScroll);
      cancelAnimationFrame(restoreFrame);
      if (tabId && editorHandles.get(tabId) === handle) editorHandles.delete(tabId);
      if (typeof unregister === 'function') unregister();
      if (crepeRef.current === crepe) crepeRef.current = null;
      // Always wait for create() to settle before destroy() — under
      // StrictMode the cleanup runs while create() is still in flight.
      void created
        .then(() => crepe.destroy())
        .catch((err: unknown) => {
          console.error('[MilkdownEditor] crepe.destroy() failed', err);
        })
        .finally(() => {
          activeInstances -= 1;
        });
    };
  }, [tabId, filePath]);

  // Content-prop sync: a changed prop while mounted is either the echo of our
  // own save (bytes match the rebaselined originalContent — ignore) or fresh
  // disk content after the handler returned 'fallback' (clean editor — swap
  // in place and rebaseline; no remount, plan §5). While dirty, conflicts are
  // the store banner's business, never a content trample.
  useEffect(() => {
    contentRef.current = content;
    applyFreshContentRef.current?.(content);
  }, [content]);

  // The gutter overlays the scroll container as a sibling (WP-P5-B): Crepe
  // owns every node inside containerRef, so React must not render into it.
  return (
    <div className="relative h-full">
      <div ref={containerRef} className="milkdown-editor h-full overflow-auto" />
      <FileCommentGutter tabId={tabId} scrollRef={containerRef} />
    </div>
  );
}

// memo-isolated: parent/store updates with unchanged props must never
// re-render (and thus never remount) the editor
export default memo(MilkdownEditor);
