import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  PlanDocumentRef,
  PlanDocumentsModel,
  PlanDocumentTab,
  PlanTabDocument,
  PlanTabKey,
  PlanTabOverview,
} from '../../../shared/types';
import { PLAN_TAB_KEYS, hasSupervisorPrivilege } from '../../../shared/types';
import { useDashboardStore } from '../../stores/dashboard-store';
import IntentLifecycleStrip from './IntentLifecycleStrip';
import PlanCommentsRail from './PlanCommentsRail';
import ProposalReader from './ProposalReader';

// WP-P4B — the tabbed, folder-native plan **document home**. Consumes the
// WP-P4A live tab projection (`plans.documents`) + guarded body read
// (`plans.readDocument`, by manifest id only) and the WP-P4C supervisor
// per-tab overview (`plans.getOverview`). It renders as TABS over the stable
// `PlanTabKey` domain — never one giant scroll (Amendment 1b).
//
// Per tab: the supervisor overview (when authored) leads, then the tab's
// document(s). The Overview tab shows the overview above `ARC.md`; the Plan tab
// renders `plan.md`; the Deliberations / Research / Supplements subdir tabs
// render a sibling list of their docs (opened read-only by manifest id, reusing
// `ProposalReader`). A populated tab with no supervisor overview shows "overview
// pending". `plan.json` / `.gitkeep` never appear — WP-P4A omits them and this
// surface exposes no raw-manifest affordance. An empty subdir reads "no
// documents yet"; the synthetic Packages tab renders its placeholder.
//
// WP-P4C-editor adds the in-place per-tab overview EDITOR here (keyed to the
// active `PlanTabKey`), gated to supervisors: the affordance shows only when a
// same-workspace privileged agent exists, and the write itself is re-validated
// SERVER-side by `plan:setOverview` (`hasSupervisorPrivilege` + membership) — the
// UI treats a rejection as a first-class outcome, never assumes success, and
// re-fetches `getOverview` after a save so the shown revision bumps. Document
// bodies stay read-only (ProposalReader owns their inert links).

/** Human labels for the stable tab keys. Display is deliberately a renderer
 *  concern (see `PlanTabKey`), so the mapping lives here, not in shared. */
const TAB_LABELS: Partial<Record<PlanTabKey, string>> = {
  overview: 'Overview',
  proposal: 'Proposal',
  plan: 'Plan',
  deliberations: 'Deliberations',
  research: 'Research',
  supplements: 'Supplements',
  'legacy-html': 'Legacy',
};

/** Subdir tabs whose docs render as a sibling list + a selected read pane. The
 *  single-doc tabs (overview→ARC, plan→plan.md, proposal, legacy-html) render
 *  their one document directly with no sibling list. */
const SUBDIR_TABS: ReadonlySet<PlanTabKey> = new Set<PlanTabKey>([
  'deliberations',
  'research',
  'supplements',
]);

interface DocReadState {
  /** The manifest id of the doc being read — dedupes stale async responses. */
  documentId: string;
  name: string;
  content: string | null;
  truncated: boolean;
  error: string | null;
  loading: boolean;
}

type DiskOverview = PlanTabOverview & {
  loadedSourceHash?: 'absent' | 'unsafe' | 'unreadable' | `sha256:${string}`;
  sourceStatus?: 'absent' | 'synced' | 'invalid' | 'apply-error';
  sourceDiagnostics?: string[];
  diskBacked?: boolean;
};

type DiskOverviewSave = PlanTabOverview & {
  outcome?: 'overview-saved' | 'overview-saved-projection-pending';
};

/** The tab's primary (auto-opened) document. WP-P4A orders each tab's docs so
 *  the canonical one leads: `ARC.md` for overview, `plan.md` for plan, the sole
 *  external doc for proposal/legacy, else the first sibling. */
function primaryDocOf(tab: PlanDocumentTab | undefined): PlanTabDocument | null {
  return tab?.documents[0] ?? null;
}

export default function PlanDocumentTabs({ planId }: { planId: string }): React.ReactElement {
  const [model, setModel] = useState<PlanDocumentsModel | null>(null);
  const [modelLoading, setModelLoading] = useState(true);
  const [activeKey, setActiveKey] = useState<PlanTabKey>('overview');
  const [overview, setOverview] = useState<PlanTabOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [doc, setDoc] = useState<DocReadState | null>(null);

  // WP-P4C-editor — in-place overview editing state (per active tab). `editing`
  // toggles the inline form; `draft` is the working body; `supervisorId` is the
  // authoring identity sent to the privileged write. `saveError` surfaces a
  // server rejection (non-supervisor / unknown plan) as a first-class outcome.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [legacySupervisorId, setLegacySupervisorId] = useState('');
  const diskOverview = overview as DiskOverview | null;
  const agents = useDashboardStore((state) => state.agents);
  const selectedWorkspaceId = useDashboardStore((state) => state.selectedWorkspaceId);
  const legacySupervisors = useMemo(() => agents
    .filter((agent) => agent.workspaceId === selectedWorkspaceId && hasSupervisorPrivilege(agent))
    .map((agent) => ({ id: agent.id, title: agent.title })), [agents, selectedWorkspaceId]);
  const canEdit = diskOverview?.diskBacked
    ? diskOverview.sourceStatus === 'synced' || diskOverview.sourceStatus === 'absent'
    : legacySupervisors.length > 0;

  // Keep the live active key in a ref so an in-flight save that resolves after
  // the user switched tabs never writes its result onto the wrong tab.
  const activeKeyRef = useRef<PlanTabKey>(activeKey);
  activeKeyRef.current = activeKey;

  // WP-P4F deep-link seam: when a caller asks to open a SPECIFIC document (not a
  // tab's primary), stash its id here so the tab-change effect opens it instead of
  // the primary. Cleared as soon as it is honored (a one-shot).
  const pendingDocIdRef = useRef<string | null>(null);

  // Load the live tab projection on mount / plan switch. Reset to the default
  // `overview` tab so a plan switch never strands the view on a key the new plan
  // lacks; `plan.json` / `.gitkeep` are already absent (WP-P4A omits them).
  useEffect(() => {
    let active = true;
    setModelLoading(true);
    setModel(null);
    setActiveKey('overview');
    void window.api.plans
      .documents(planId)
      .then((m) => {
        if (!active) return;
        setModel(m);
        setModelLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setModel(null);
        setModelLoading(false);
      });
    return () => {
      active = false;
    };
  }, [planId]);

  const tabs = model?.tabs ?? [];
  // Render tab buttons in the canonical `PLAN_TAB_KEYS` order, restricted to the
  // keys the projection actually returned (so the type and the live set agree).
  const orderedTabs = useMemo(() => {
    const byKey = new Map(tabs.map((t) => [t.key, t]));
    return PLAN_TAB_KEYS.map((k) => byKey.get(k)).filter((t): t is PlanDocumentTab => Boolean(t));
  }, [tabs]);
  const activeTab = useMemo(() => tabs.find((t) => t.key === activeKey), [tabs, activeKey]);

  // The currently-open document (matched by manifest id), passed to the comments
  // rail so a new comment is created against its opaque ref and threads scope to
  // it (WP-P4E). Null on Packages / empty tabs or before a doc has opened. Defined
  // BEFORE the early returns below so hook order stays stable across renders.
  const activeDoc = useMemo<PlanTabDocument | null>(
    () => activeTab?.documents.find((d) => d.ref.documentId === doc?.documentId) ?? null,
    [activeTab, doc?.documentId],
  );

  // Read a document body by its opaque manifest id (never a raw path). Guards
  // against a stale response landing after the user moved on by keying on the id.
  const openDoc = useCallback(
    (target: PlanTabDocument) => {
      const id = target.ref.documentId;
      setDoc({ documentId: id, name: target.name, content: null, truncated: false, error: null, loading: true });
      void window.api.plans
        .readDocument(planId, target.ref)
        .then((res) => {
          setDoc((prev) => {
            // A newer selection superseded this read; drop the late response.
            if (!prev || prev.documentId !== id) return prev;
            if ('error' in res) {
              return { documentId: id, name: target.name, content: null, truncated: false, error: res.error, loading: false };
            }
            return { documentId: id, name: res.name, content: res.content, truncated: res.truncated, error: null, loading: false };
          });
        })
        .catch(() => {
          setDoc((prev) =>
            prev && prev.documentId === id
              ? { documentId: id, name: target.name, content: null, truncated: false, error: 'Could not read document', loading: false }
              : prev,
          );
        });
    },
    [planId],
  );

  // On tab change (or model arrival): fetch the supervisor overview for the tab
  // and auto-open its primary document. Overview read is open (any renderer);
  // a null/blank body simply means "no overview" and the pending hint applies.
  useEffect(() => {
    if (!model || !activeTab) {
      setOverview(null);
      setDoc(null);
      return;
    }
    let active = true;
    setOverviewLoading(true);
    setOverview(null);
    void window.api.plans
      .getOverview(planId, activeKey)
      .then((ov) => {
        if (!active) return;
        setOverview(ov);
        setOverviewLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setOverview(null);
        setOverviewLoading(false);
      });

    // Honor a pending deep-link target for this tab (a specific doc), else fall
    // back to the tab's primary. The pending id is a one-shot — consume it here.
    const pendingId = pendingDocIdRef.current;
    pendingDocIdRef.current = null;
    const pending = pendingId ? activeTab.documents.find((d) => d.ref.documentId === pendingId) : undefined;
    const toOpen = pending ?? primaryDocOf(activeTab);
    if (toOpen) openDoc(toOpen);
    else setDoc(null);

    return () => {
      active = false;
    };
  }, [planId, activeKey, model, activeTab, openDoc]);

  // Controlled-selection seam (WP-P4F; WP-P6/P7 may reuse): switch to `key` and
  // open the manifest doc `ref`. Same-tab opens directly (no key change to drive
  // the effect); a cross-tab open stashes the target and lets the effect open it
  // after the switch, so the primary-doc auto-open never clobbers the deep-link.
  const openDocument = useCallback(
    (key: PlanTabKey, ref: PlanDocumentRef) => {
      const tab = model?.tabs.find((t) => t.key === key);
      const target = tab?.documents.find((d) => d.ref.documentId === ref.documentId);
      if (key === activeKeyRef.current) {
        pendingDocIdRef.current = null;
        if (target) openDoc(target);
        return;
      }
      pendingDocIdRef.current = ref.documentId;
      setActiveKey(key);
    },
    [model, openDoc],
  );

  const hasOverview = Boolean(overview?.body && overview.body.trim().length > 0);

  // Leaving a tab (or switching plans) closes any open editor so the draft never
  // bleeds across keys; the per-tab overview fetch above re-primes the body.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
  }, [activeKey, planId]);

  // Open the inline editor seeded with the current overview body and a default
  // author (the first candidate supervisor, kept if still valid).
  const startEdit = useCallback(() => {
    setDraft(overview?.body ?? '');
    setSaveError(null);
    if (!diskOverview?.diskBacked) {
      setLegacySupervisorId((prior) => legacySupervisors.some((agent) => agent.id === prior)
        ? prior : legacySupervisors[0]?.id ?? '');
    }
    setEditing(true);
  }, [overview, diskOverview?.diskBacked, legacySupervisors]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setSaveError(null);
  }, []);

  // Privileged write. Sends the trimmed body (all-whitespace ⇒ null, clearing the
  // overview) under the chosen supervisor identity; on success re-fetches the same
  // getOverview so the shown revision bumps, on rejection keeps the editor open
  // and surfaces the reason — the server is the authority, so we never assume the
  // write landed.
  const saveOverview = useCallback(async () => {
    if (!canEdit || saving || (diskOverview?.diskBacked && !diskOverview.loadedSourceHash)) return;
    const key = activeKey;
    if (draft.trim().length === 0) {
      setSaveError('Enter an overview, or use Remove to delete the section.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const request = diskOverview?.diskBacked
        ? { planId, tab: key, body: draft, action: 'save', expectedSourceHash: diskOverview.loadedSourceHash }
        : { planId, tab: key, body: draft, supervisorId: legacySupervisorId };
      const saved = await window.api.plans.setOverview(
        request as Parameters<typeof window.api.plans.setOverview>[0],
      ) as DiskOverviewSave;
      const ov = await window.api.plans.getOverview(planId, key);
      // Guard against a tab switch mid-save landing on the wrong key.
      if (activeKeyRef.current === key) {
        setOverview(ov);
        setEditing(false);
        if (saved.outcome === 'overview-saved-projection-pending') {
          setSaveError('The overview was saved to disk but has not reached the surface yet. Refresh to retry.');
        }
      }
    } catch (err) {
      if (activeKeyRef.current === key) {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(!diskOverview?.diskBacked
          ? 'Could not save the overview — only a supervisor can edit it.'
          : /stale|changed on disk/i.test(message)
          ? 'The overview changed on disk while you were editing. Reload and merge your draft.'
          : 'Could not save the overview. The responsible supervisor or file state may have changed.');
      }
    } finally {
      setSaving(false);
    }
  }, [canEdit, saving, activeKey, draft, planId, diskOverview?.diskBacked,
    diskOverview?.loadedSourceHash, legacySupervisorId]);

  const removeOverview = useCallback(async () => {
    if (!canEdit || saving || !diskOverview?.loadedSourceHash) return;
    const key = activeKey;
    setSaving(true);
    setSaveError(null);
    try {
      await window.api.plans.setOverview({
        planId, tab: key, body: null, action: 'remove',
        expectedSourceHash: diskOverview.loadedSourceHash,
      } as unknown as Parameters<typeof window.api.plans.setOverview>[0]);
      const ov = await window.api.plans.getOverview(planId, key);
      if (activeKeyRef.current === key) {
        setOverview(ov);
        setEditing(false);
      }
    } catch (err) {
      if (activeKeyRef.current === key) {
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(/stale|changed on disk/i.test(message)
          ? 'The overview changed on disk while you were editing. Reload and merge your draft.'
          : 'Could not remove the overview section.');
      }
    } finally { setSaving(false); }
  }, [canEdit, saving, diskOverview?.loadedSourceHash, activeKey, planId]);

  if (modelLoading) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-gray-400" data-testid="plan-document-tabs">
        Loading…
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-gray-500" data-testid="plan-document-tabs">
        <span data-testid="plan-document-tabs-missing">Plan not found</span>
      </div>
    );
  }

  const siblings = activeTab && SUBDIR_TABS.has(activeKey) ? activeTab.documents : [];
  const showEmpty = Boolean(activeTab && activeTab.documents.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0" data-testid="plan-document-tabs">
      {/* WP-P4F — persistent intent-lifecycle strip ABOVE the tabs. It renders
          nothing until the P2L projection resolves, so the document home is
          untouched pre-ledger. Deep-links resolve through `openDocument`. */}
      <IntentLifecycleStrip planId={planId} model={model} onOpenDocument={openDocument} />

      {/* Tab strip — stable keys, canonical order. Never one giant scroll. */}
      <div
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-white/10 px-2"
        role="tablist"
        aria-label="Plan documents"
        data-testid="plan-tabs"
      >
        {orderedTabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === activeKey}
            onClick={() => setActiveKey(t.key)}
            data-testid="plan-tab"
            data-tab-key={t.key}
            data-populated={t.populated ? 'true' : 'false'}
            className={`shrink-0 border-b-2 px-3 py-1.5 text-[12px] ${
              t.key === activeKey
                ? 'border-accent-blue text-gray-100'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            {TAB_LABELS[t.key] ?? t.key}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1" data-testid="plan-tab-body">
       <div className="flex min-h-0 flex-1 flex-col">
        {/* Overview row — leads every populated tab. Supervisor-authored summary
            when present; "overview pending" on a populated tab that has none;
            an in-place editor for a supervisor (WP-P4C-editor). */}
        {(hasOverview || editing || (activeTab?.populated && !overviewLoading)) && (
          <div className="shrink-0 border-b border-white/10 bg-surface-1/40 px-6 py-3" data-testid="plan-tab-overview">
            {editing ? (
              <div className="max-w-3xl" data-testid="plan-overview-editor">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={5}
                  placeholder="Plain-language overview for this tab…"
                  disabled={saving}
                  data-testid="plan-overview-textarea"
                  className="w-full resize-y rounded border border-white/15 bg-surface-0 px-2 py-1.5 text-[13px] text-gray-200 outline-none focus:border-accent-blue disabled:opacity-60"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {!diskOverview?.diskBacked && legacySupervisors.length > 1 && (
                    <select
                      value={legacySupervisorId}
                      onChange={(event) => setLegacySupervisorId(event.target.value)}
                      disabled={saving}
                      data-testid="plan-overview-supervisor-select"
                      aria-label="Authoring supervisor"
                      className="rounded border border-white/15 bg-surface-0 px-1.5 py-1 text-[12px] text-gray-200"
                    >
                      {legacySupervisors.map((supervisor) => (
                        <option key={supervisor.id} value={supervisor.id}>{supervisor.title}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => void saveOverview()}
                    disabled={saving || (!diskOverview?.diskBacked && !legacySupervisorId)}
                    data-testid="plan-overview-save"
                    className="rounded bg-accent-blue px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-60"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={saving}
                    data-testid="plan-overview-cancel"
                    className="rounded px-2.5 py-1 text-[12px] text-gray-400 hover:text-gray-200 disabled:opacity-60"
                  >
                    Cancel
                  </button>
                  {hasOverview && diskOverview?.diskBacked && (
                    <button
                      type="button"
                      onClick={() => void removeOverview()}
                      disabled={saving}
                      data-testid="plan-overview-remove"
                      className="rounded px-2.5 py-1 text-[12px] text-red-400 hover:text-red-300 disabled:opacity-60"
                    >
                      Remove
                    </button>
                  )}
                  {saveError && (
                    <span className="text-[12px] text-red-400" data-testid="plan-overview-error" role="alert">
                      {saveError}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                {hasOverview ? (
                  <div className="prose-custom min-w-0 max-w-3xl flex-1 text-[13px] text-gray-300" data-testid="plan-tab-overview-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{overview!.body!}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="flex-1 text-[12px] italic text-gray-500" data-testid="plan-overview-pending">
                    {diskOverview?.sourceStatus === 'invalid'
                      ? 'The human overview could not be read. Repair OVERVIEW.md; the last valid summaries remain visible but cannot make the plan ready.'
                      : diskOverview?.sourceStatus === 'absent'
                        ? 'No human overview has been written yet. Package this plan or add an overview before Mark Ready.'
                        : 'This tab has content but no plain-language summary. Add its section before Mark Ready.'}
                  </div>
                )}
                {canEdit && (
                  <button
                    type="button"
                    onClick={startEdit}
                    data-testid="plan-overview-edit"
                    className="shrink-0 rounded border border-white/15 px-2 py-0.5 text-[11px] text-gray-400 hover:text-gray-200"
                  >
                    {hasOverview ? 'Edit' : 'Add overview'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Document region. */}
        {showEmpty ? (
          <div
            className="flex flex-1 items-center justify-center px-6 text-[13px] text-gray-500"
            data-testid={activeTab?.placeholder ? 'plan-packages-placeholder' : 'plan-tab-empty'}
          >
            {activeTab?.placeholder ?? 'no documents yet'}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* Subdir tabs: a sibling list of manifest-id docs on the left. */}
            {siblings.length > 0 && (
              <aside className="w-56 shrink-0 overflow-auto border-r border-white/10 py-2" data-testid="plan-tab-siblings">
                {siblings.map((s) => (
                  <button
                    key={s.ref.documentId}
                    type="button"
                    onClick={() => openDoc(s)}
                    data-testid="plan-tab-sibling"
                    data-doc-kind={s.kind}
                    className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[11px] hover:bg-white/[0.06] ${
                      s.ref.documentId === doc?.documentId ? 'text-accent-blue' : 'text-gray-400'
                    }`}
                  >
                    <span className="shrink-0 rounded bg-surface-2 px-1 text-[9px] uppercase text-gray-500">{s.kind}</span>
                    <span className="truncate" title={s.name}>
                      {s.name}
                    </span>
                  </button>
                ))}
              </aside>
            )}
            <div className="min-w-0 flex-1">
              {activeDoc?.machine?.status === 'invalid' ? (
                <div
                  className="flex h-full items-center justify-center px-6 text-center text-[13px] text-amber-300"
                  data-testid="plan-supplement-machine-diagnostic"
                >
                  This work-package file couldn't be read. Fix its machine block; the parsed board shows the last valid packages.
                </div>
              ) : (
                <ProposalReader
                  name={doc?.name ?? null}
                  content={doc?.content ?? null}
                  truncated={doc?.truncated ?? false}
                  error={doc?.error ?? null}
                  loading={doc?.loading ?? false}
                />
              )}
            </div>
          </div>
        )}
       </div>

        {/* WP-P4E — comments rail. Threads scope to the open document; a compose
            box routes create through the server (which picks the recipient), and
            orphaned targets stay visible but non-clickable. */}
        <PlanCommentsRail planId={planId} activeDoc={activeDoc} />
      </div>
    </div>
  );
}
