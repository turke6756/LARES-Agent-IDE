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
 * `setDraftContent` (saves route through the save coordinator's
 * `requestSave`, edit-loss Phase 2), the way CodeMirrorEditor's callbacks do. It
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
import { editorViewCtx, editorViewOptionsCtx, prosePluginsCtx } from '@milkdown/kit/core';
import { replaceAll } from '@milkdown/kit/utils';
import { Plugin as ProsePlugin } from '@milkdown/kit/prose/state';
import type { EditorView } from '@milkdown/kit/prose/view';
import '@milkdown/crepe/theme/common/style.css';
// Theme-aware palette (light + dark) keyed off the app's <html> theme class,
// instead of the single prebuilt frame-dark theme that rendered black in light
// mode. See milkdownTheme.css.
import './milkdownTheme.css';
import { useDashboardStore } from '../../stores/dashboard-store';
import { diag, diagBasename, diagHash, nextEditorMountGeneration } from './editLossDiag';
import FileCommentGutter from '../selection/FileCommentGutter';
import { getTabScrollFraction, setTabScrollFraction } from './scrollMemory';
import {
  contentHash,
  prepareSpliceBaseline,
  spliceMarkdown,
  getSpliceFallbackCount,
  onSpliceFallback,
  type SpliceBaseline,
} from './markdownSplice';
import {
  currentRevision,
  registerSaveAdapter,
  requestSave,
  storeExpectedDiskHash,
  type SaveAdapter,
  type SaveSnapshot,
} from './saveCoordinator';
import { useAutosave } from './useAutosave';

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

  // Autosave (edit-loss §4.2): onEdit is the undebounced edit signal (it owns
  // noteEdit + the idle timer); rootRef arms the focusout flush trigger. The
  // hook's unmount flush runs AFTER this component's layout cleanup (passive
  // cleanups follow layout cleanups), i.e. after flushDirtyDraft() landed the
  // final draft in the store — the coordinator's store adapter carries it.
  const { onEdit, rootRef: autosaveRootRef } = useAutosave(tabId);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;

  // Refs keep the mount effect's dep list down to identity (tabId/filePath):
  // store actions, the registration seam, and the content prop must be
  // readable from inside the effect without remounting the editor.
  const setDraftContentRef = useRef(setDraftContent);
  const registerRef = useRef(registerFreshContentHandler);
  const contentRef = useRef(content);
  useEffect(() => {
    setDraftContentRef.current = setDraftContent;
    registerRef.current = registerFreshContentHandler;
  }, [setDraftContent, registerFreshContentHandler]);

  const crepeRef = useRef<Crepe | null>(null);
  const readyRef = useRef(false);
  const baselineRef = useRef<SpliceBaseline | null>(null);
  /** Crepe's own serialization of the last loaded/saved state — the dirty baseline. */
  const loadSerializedRef = useRef('');
  /** The exact bytes THIS mount initialized from (B2's byte-side twin): the
   * dirty store draft on a draft mount, else the disk original. "Back to
   * pristine" restores these bytes — never the splice baseline's original. */
  const mountBytesRef = useRef('');
  const dirtyRef = useRef(false);
  /** Set by the mount effect; lets the content-sync effect reach the live instance. */
  const applyFreshContentRef = useRef<((fresh: string) => void) | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    readyRef.current = false;
    dirtyRef.current = false;

    // Mount-from-draft (plan §1.2): a dirty store draft is the user's unsaved
    // work — EVERY mount initializes the canvas from it; only a pristine tab
    // mounts from the disk original. B1 (the splice baseline below) stays the
    // DISK ORIGINAL bytes regardless, so post-draft-mount edits keep full
    // splice/EOL fidelity against what is actually on disk. B3 (store
    // draft/dirty) is left untouched — Save stays enabled.
    const mountEditState = useDashboardStore.getState().tabEditState[tabId];
    const mountReloadVersion = mountEditState?.reloadVersion ?? 0;
    const mountedFromDraft = !!mountEditState?.dirty;
    const mountText = mountedFromDraft
      ? mountEditState.draftContent
      : contentRef.current;
    mountBytesRef.current = mountText;

    // DIAG(edit-loss): per-mount generation + what this mount initializes from
    // vs what the store believes.
    const mountGen = nextEditorMountGeneration();
    diag('editor-mount', {
      gen: mountGen,
      tabId,
      file: diagBasename(filePath),
      contentHash: diagHash(contentRef.current),
      storeDirty: mountedFromDraft,
      draftHash: diagHash(mountEditState?.draftContent),
      mountTextHash: diagHash(mountText),
      reloadVersion: mountEditState?.reloadVersion ?? 0,
      mode: mountEditState?.mode,
    });

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
      // A draft mount loads the draft's bytes (LF-normalized for the editor);
      // a pristine mount keeps the baseline's prepared editorContent.
      defaultValue: mountedFromDraft
        ? normalizeEolLocal(mountText)
        : baseline
          ? baseline.editorContent
          : normalizeEolLocal(mountText),
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

    // Undebounced revision source (edit-loss Phase 2 §2.1): a per-transaction
    // ProseMirror plugin — NOT Crepe's `listener.updated`, which this
    // @milkdown/plugin-listener version debounces 200ms exactly like
    // `markdownUpdated` (see saveCoordinator.noteEdit). Every doc-changing
    // transaction advances the tab's revision synchronously with dispatch, so
    // the coordinator's gate (a) sees an edit the instant it lands. Since
    // Phase 4B the signal routes through useAutosave's onEdit, which calls
    // noteEdit AND re-arms the idle autosave timer (§4.2).
    const editRevisionPlugin = new ProsePlugin({
      state: {
        init: () => null,
        apply: (tr) => {
          if (tr.docChanged && tabId) onEditRef.current();
          return null;
        },
      },
    });

    crepe.editor.config((ctx) => {
      ctx.update(editorViewOptionsCtx, (prev) => ({
        ...prev,
        attributes: { ...(prev.attributes ?? {}), spellcheck: 'true' },
      }));
      ctx.update(prosePluginsCtx, (prev) => [...prev, editRevisionPlugin]);
    });

    /** Splice the editor state against the original bytes and push it as the
     * store draft. Returns the draft that was pushed. */
    const pushSplicedDraft = (markdown: string): string => {
      const b = baselineRef.current;
      // Degraded path (baseline prep failed at mount): whole-doc, LF.
      const draft = b ? spliceMarkdown(b, markdown).content : markdown;
      setDraftContentRef.current(tabId, draft);
      return draft;
    };

    const editorIsDirty = (): boolean =>
      readyRef.current && !disposed && crepe.getMarkdown() !== loadSerializedRef.current;

    const storeDirty = (): boolean =>
      !!useDashboardStore.getState().tabEditState[tabId]?.dirty;

    /** Dirty-for-save ⇔ the live doc differs from THIS mount's serialization
     * (B2) OR any lagging/store authority still flags unsaved work (plan
     * §1.3b: editor-live ∨ dirtyRef ∨ B3). A draft-mounted canvas is
     * editor-pristine but store-dirty — its preserved draft must still save
     * and must still conflict with external changes. */
    const saveDirty = (): boolean =>
      editorIsDirty() || dirtyRef.current || storeDirty();

    /** Dirty iff Crepe's serialization differs from the load/save baseline
     * (plan §5) — only then does the store hear about a draft. */
    const syncDirtyState = (markdown: string) => {
      if (!readyRef.current || disposed) return;
      if (markdown === loadSerializedRef.current) {
        if (dirtyRef.current) {
          dirtyRef.current = false;
          // Back to the MOUNT state (e.g. undo): restore the bytes this mount
          // loaded — on a draft mount those are the dirty draft, NOT the
          // splice baseline's disk original (plan §1.3a). Writing the
          // original here would silently mark the store clean while the
          // canvas still shows unsaved work.
          setDraftContentRef.current(tabId, mountBytesRef.current);
        }
        return;
      }
      dirtyRef.current = true;
      pushSplicedDraft(markdown);
    };

    const flushDirtyDraft = (): string | null => {
      if (!editorIsDirty()) {
        if (dirtyRef.current) syncDirtyState(crepe.getMarkdown());
        return null;
      }
      const markdown = crepe.getMarkdown();
      dirtyRef.current = true;
      return pushSplicedDraft(markdown);
    };

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        syncDirtyState(markdown);
      });
    });

    /** Save adapter (edit-loss Phase 2 §2.1): the coordinator's window into
     * this mount. `snapshot()` flushes the splice SYNCHRONOUSLY — the
     * markdownUpdated listener is debounced 200ms and may lag a keystroke —
     * and reports unsaved work when ANY dirty authority says so: a
     * draft-mounted canvas is editor-pristine while its preserved work lives
     * only in the store, and that draft must still reach disk. `rebaseline()`
     * installs B1+B2 after a fully-gated completed write; both are no-ops
     * once this mount is disposed (the mount-generation guard — each mount
     * registers its own closure). */
    const saveAdapter: SaveAdapter = {
      snapshot: (): SaveSnapshot | null => {
        if (disposed || !readyRef.current) return null;
        // Live flush wins; else the preserved store draft; null ⇒ genuinely
        // pristine ⇒ nothing to write. Re-read the store AFTER the flush —
        // flushDirtyDraft may itself update the draft.
        const flushed = flushDirtyDraft();
        const es = useDashboardStore.getState().tabEditState[tabId];
        const draft = flushed ?? (es?.dirty ? es.draftContent : null);
        if (draft === null) return null;
        return {
          draft,
          revision: currentRevision(tabId),
          editorSerialized: crepe.getMarkdown(),
          // §4.1: the store's CAS guard (falls back to hash(originalContent)
          // for pre-4.1 state) — enforced by the conditional-write IPC.
          expectedDiskHash: storeExpectedDiskHash(es),
        };
      },
      rebaseline: (written: SaveSnapshot) => {
        if (disposed || !readyRef.current) return;
        // Rebaseline B1 (splice baseline = written bytes) + B2 (this mount's
        // serialization) + the mount bytes; dirtyRef recomputed against the
        // fresh B2 (plan §1.3d). The coordinator's gate (b) guarantees the
        // live serialization still equals the captured one here.
        try {
          baselineRef.current = prepareSpliceBaseline(written.draft);
        } catch (err) {
          console.error('[MilkdownEditor] rebaseline after save failed', err);
        }
        mountBytesRef.current = written.draft;
        loadSerializedRef.current = crepe.getMarkdown();
        dirtyRef.current = editorIsDirty();
      },
    };
    // Registered once create() settles (below): a request that arrives while
    // create() is still in flight must fall back to the coordinator's store
    // adapter (which writes the preserved draft) rather than hit a
    // half-initialized snapshot that would misreport "pristine".
    let unregisterAdapter: (() => void) | null = null;

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        // Never let the window-level Ctrl+S handler (FileViewerPanel /
        // DetachedFileView) double-fire on the same gesture (plan §2.3);
        // coordinator coalescing is the backstop, not the primary defense.
        e.stopPropagation();
        if (tabId) void requestSave(tabId);
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
      ? registerRef.current?.(tabId, () => {
          // saveDirty() (plan §1.3b): a draft-mounted canvas is
          // editor-pristine but still carries unsaved store work — external
          // content must conflict, never silently replace it.
          const editorDirty = editorIsDirty();
          const verdict: FreshContentResult =
            editorDirty || dirtyRef.current || storeDirty() ? 'conflict' : 'fallback';
          // DIAG(edit-loss): handler verdict + which dirty authority produced it.
          diag('handler-verdict', {
            gen: mountGen,
            tabId,
            verdict,
            editorDirty,
            dirtyRef: dirtyRef.current,
            storeDirty: storeDirty(),
          });
          return verdict;
        })
      : undefined;

    /** Clean-editor content swap + baseline refresh (plan §5 'fallback').
     * R7 live triple-check AT REPLACEMENT TIME (plan §1.3c): the decision to
     * swap was made earlier (handler consult / prop change) — re-verify
     * against the LIVE doc and the store at the moment replaceAll would run.
     * The debounced dirtyRef alone is not a safe guard (H3 TOCTOU), and a
     * draft-mounted canvas is editor-pristine while the store still carries
     * unsaved work — without the store check, the post-create
     * applyFreshContent(original) would replaceAll(original) over the
     * just-mounted draft. */
    const applyFreshContent = (fresh: string) => {
      const blocked = (guard: string) => {
        // DIAG(edit-loss): which guard blocked the replace.
        diag('apply-fresh-blocked', {
          gen: mountGen,
          tabId,
          freshHash: diagHash(fresh),
          guard,
          disposed,
          ready: readyRef.current,
          dirtyRef: dirtyRef.current,
        });
      };
      if (disposed || !readyRef.current) return blocked('disposed-or-not-ready');
      if (crepe.getMarkdown() !== loadSerializedRef.current) return blocked('live-doc-differs');
      if (useDashboardStore.getState().tabEditState[tabId]?.dirty) return blocked('store-dirty');
      if (fresh === baselineRef.current?.originalContent) {
        // DIAG(edit-loss): fresh bytes already ARE the baseline — no-op.
        diag('apply-fresh-baseline-match', {
          gen: mountGen,
          tabId,
          freshHash: diagHash(fresh),
        });
        return;
      }
      try {
        const next = prepareSpliceBaseline(fresh);
        crepe.editor.action(replaceAll(next.editorContent, true));
        baselineRef.current = next;
        loadSerializedRef.current = crepe.getMarkdown();
        mountBytesRef.current = fresh;
        dirtyRef.current = false;
        // DIAG(edit-loss): replaceAll ran — the live doc was swapped.
        diag('apply-fresh-replaced', {
          gen: mountGen,
          tabId,
          freshHash: diagHash(fresh),
        });
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
        // Live snapshots are meaningful from here on — take over from the
        // coordinator's store-adapter fallback (identity-guarded unregister,
        // so a successor mount's registration is never torn down by us).
        if (tabId) unregisterAdapter = registerSaveAdapter(tabId, saveAdapter);
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
      // An explicit "Reload from disk" bumped reloadVersion and reset the
      // store to the disk bytes; since the canvas now mounts FROM the store
      // draft (plan §1.2), this dying mount's flush must not resurrect the
      // discarded draft over the reload — the successor mount would show it
      // instead of the disk bytes. The flush authority is scoped to this
      // mount's own reload generation.
      const supersededByReload =
        (useDashboardStore.getState().tabEditState[tabId]?.reloadVersion ?? 0) !==
        mountReloadVersion;
      // DIAG(edit-loss): the single flushDirtyDraft() call — capture its
      // return value once into a local, log it, never call twice.
      const flushedDraft = supersededByReload ? null : flushDirtyDraft();
      diag('editor-cleanup', {
        gen: mountGen,
        tabId,
        dirtyRef: dirtyRef.current,
        supersededByReload,
        flushedDraftHash: flushedDraft === null ? null : diagHash(flushedDraft),
      });
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
      // After this the coordinator's store-adapter fallback carries any
      // still-queued save for the flushed draft (Phase 4 adds the unmount
      // flush that relies on exactly that).
      unregisterAdapter?.();
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
    // DIAG(edit-loss): content-prop sync effect fired.
    diag('content-sync-effect', { tabId, contentHash: diagHash(content) });
    applyFreshContentRef.current?.(content);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tabId is read for DIAG logging only; keying this effect on it would change replace timing
  }, [content]);

  // The gutter overlays the scroll container as a sibling (WP-P5-B): Crepe
  // owns every node inside containerRef, so React must not render into it.
  return (
    <div className="relative h-full" ref={autosaveRootRef}>
      <div ref={containerRef} className="milkdown-editor h-full overflow-auto" />
      <FileCommentGutter tabId={tabId} scrollRef={containerRef} />
    </div>
  );
}

// memo-isolated: parent/store updates with unchanged props must never
// re-render (and thus never remount) the editor
export default memo(MilkdownEditor);
