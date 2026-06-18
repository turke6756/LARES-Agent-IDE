import React, { useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  type AccessRequest,
  type AccessRequestDecision,
  type AccessRule,
  type AccessRuleInput,
} from '../../stores/browser-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── Website-access settings (plans/website-allowlist-simplification.md §6) ─────
// Full-pane overlay (modeled on HistoryView) for the SIMPLIFIED, single-list
// website-access policy. There is ONE human-curated agent allowlist; enforcement
// is keyed solely to the global Agent Actions toggle — there is no second
// "human hand-off" list and no per-list off/enforce mode. Two zones:
//   (1) Pending approvals — a prominent, gently-pulsing box at the TOP listing
//       agent-initiated `browser_access_requests`. It is an INERT inbox: only a
//       human approval here ever creates a real rule (§18). All agent-supplied
//       strings (reason, hostname) render as PLAIN ESCAPED TEXT — React escapes
//       text children, and we never linkify or use dangerouslySetInnerHTML.
//   (2) The agent allowlist — COLLAPSED BY DEFAULT, expandable + scrollable. Has
//       an add-rule form and per-row enable/delete plus the per-row "Allow
//       sign-in hand-off" (allowSignedIn) authenticated-drive toggle (§11–§15).
// There is NO allowSensitive control anywhere (the sensitive-origin act denial
// stays non-overridable — §4/§14). Opening a page FOR the human
// (for_human_action) is OUTSIDE this entirely — it is never gated by the list.
//
// Because a WebContentsView paints above renderer DOM, the inner component
// suspends the pane for its lifetime (useBrowserSuspension), exactly like
// HistoryView; the pane is restored on close.

/** A human-readable description of the canonical rule an input would create —
 *  computed by trusted code from the (server-normalized) fields, never the
 *  agent's raw string. e.g. "https://*.github.com/app". */
function ruleDescriptor(r: {
  hostname: string;
  scheme: 'https' | 'http' | 'any';
  includeSubdomains: boolean;
  pathPrefix?: string;
}): string {
  const scheme = r.scheme === 'any' ? 'http(s)' : r.scheme;
  const host = r.includeSubdomains ? `*.${r.hostname}` : r.hostname;
  const path = r.pathPrefix && r.pathPrefix !== '/' ? r.pathPrefix : '';
  return `${scheme}://${host}${path}`;
}

// ── Add-rule form ─────────────────────────────────────────────────────────────
function AddRuleForm() {
  const addAccessRule = useBrowserStore((s) => s.addAccessRule);

  const [hostname, setHostname] = useState('');
  const [includeSubdomains, setIncludeSubdomains] = useState(true);
  const [scheme, setScheme] = useState<'https' | 'http' | 'any'>('https');
  const [pathPrefix, setPathPrefix] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setHostname('');
    setIncludeSubdomains(true);
    setScheme('https');
    setPathPrefix('');
    setNote('');
  };

  const submit = async () => {
    const host = hostname.trim();
    if (!host || busy) return;
    setBusy(true);
    setError(null);
    const input: AccessRuleInput = {
      hostname: host,
      includeSubdomains,
      scheme,
      pathPrefix: pathPrefix.trim() || undefined,
      note: note.trim() || undefined,
    };
    try {
      // Main re-normalizes the hostname and THROWS on `*`/unparseable input —
      // surface that message inline rather than swallowing it.
      await addAccessRule(input);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this rule — check the hostname.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-browser-chrome-2)] p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={hostname}
          spellCheck={false}
          placeholder="hostname (e.g. github.com)"
          onChange={(e) => setHostname(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          className="flex-1 min-w-[160px] bg-[var(--color-surface-0)] border border-tab-border px-2 py-1.5 text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60"
        />
        <select
          value={scheme}
          onChange={(e) => setScheme(e.target.value as 'https' | 'http' | 'any')}
          className="bg-[var(--color-surface-0)] border border-tab-border px-2 py-1.5 text-[12px] text-fg-primary focus:outline-none"
          title="Scheme — 'any' still requires the http(s) floor"
        >
          <option value="https">https</option>
          <option value="http">http</option>
          <option value="any">any</option>
        </select>
        <input
          type="text"
          value={pathPrefix}
          spellCheck={false}
          placeholder="/path-prefix (optional)"
          onChange={(e) => setPathPrefix(e.target.value)}
          className="w-[150px] bg-[var(--color-surface-0)] border border-tab-border px-2 py-1.5 text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-fg-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={includeSubdomains}
            onChange={(e) => setIncludeSubdomains(e.target.checked)}
          />
          Include subdomains
        </label>
        <input
          type="text"
          value={note}
          spellCheck={false}
          placeholder="note (optional)"
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 min-w-[120px] bg-[var(--color-surface-0)] border border-tab-border px-2 py-1.5 text-[12px] text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || !hostname.trim()}
          className="ui-btn ui-btn-primary px-3 py-1.5 text-[12px] font-medium shrink-0 disabled:opacity-40"
        >
          <Icons.Plus className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      {hostname.trim() && !error && (
        <div className="text-[10px] text-fg-muted">
          Will allow{' '}
          <span className="font-mono text-fg-secondary">
            {ruleDescriptor({ hostname: hostname.trim(), scheme, includeSubdomains, pathPrefix: pathPrefix.trim() || undefined })}
          </span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-accent-red">
          <Icons.AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ── A single agent-allowlist rule row ─────────────────────────────────────────
function RuleRow({ rule }: { rule: AccessRule }) {
  const updateAccessRule = useBrowserStore((s) => s.updateAccessRule);
  const removeAccessRule = useBrowserStore((s) => s.removeAccessRule);
  const beginSigninHandoff = useBrowserStore((s) => s.beginSigninHandoff);
  const clearSiteSession = useBrowserStore((s) => s.clearSiteSession);

  const [confirmingOff, setConfirmingOff] = useState(false);

  const toggleSignedIn = () => {
    if (rule.allowSignedIn) {
      // Turning OFF revokes the capability; offer to clear the stored session
      // (no silent auto-clear — §15/Q5).
      setConfirmingOff(true);
    } else {
      void updateAccessRule(rule.id, { allowSignedIn: true });
    }
  };

  const confirmOff = (alsoClear: boolean) => {
    setConfirmingOff(false);
    void updateAccessRule(rule.id, { allowSignedIn: false });
    if (alsoClear) void clearSiteSession(rule.id);
  };

  return (
    <div className="rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <button
          onClick={() => void updateAccessRule(rule.id, { enabled: !rule.enabled })}
          className={`shrink-0 ${rule.enabled ? 'text-accent-orange' : 'text-fg-muted'}`}
          title={rule.enabled ? 'Disable this rule' : 'Enable this rule'}
        >
          {rule.enabled ? <Icons.ToggleRight className="w-5 h-5" /> : <Icons.ToggleLeft className="w-5 h-5" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className={`text-[12px] font-mono truncate ${rule.enabled ? 'text-fg-primary' : 'text-fg-muted line-through'}`}>
            {ruleDescriptor(rule)}
          </div>
          {rule.note && <div className="text-[10px] text-fg-muted truncate">{rule.note}</div>}
        </div>
        <button
          onClick={() => void removeAccessRule(rule.id)}
          className="ui-btn ui-btn-ghost p-1 shrink-0 hover:text-accent-red"
          title="Delete rule"
        >
          <Icons.Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Per-row authenticated-drive ("Allow sign-in hand-off") toggle. */}
      <div className="flex items-start gap-2 pl-8">
        <button
          type="button"
          role="switch"
          aria-checked={rule.allowSignedIn}
          aria-label="Allow sign-in hand-off"
          onClick={toggleSignedIn}
          className="shrink-0 mt-0.5"
          title="Let the agent use my signed-in session (right-click hand-off becomes eligible for this origin)"
        >
          <span
            className={`relative inline-flex h-3.5 w-6 items-center rounded-full transition-colors ${
              rule.allowSignedIn ? 'bg-accent-orange' : 'bg-tab-border'
            }`}
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full bg-white transition-transform ${
                rule.allowSignedIn ? 'translate-x-3' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-fg-secondary">Allow sign-in hand-off</div>
          <div className="text-[10px] text-fg-muted">
            Lets the agent drive your signed-in session here; shared by every agent in this
            workspace; persists until you clear it.
          </div>
        </div>
        {rule.allowSignedIn && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => void beginSigninHandoff(rule)}
              className="ui-btn ui-btn-outline px-2 py-1 text-[11px]"
              title="Open a quarantined login tab so you can sign in for the agent"
            >
              <Icons.LogIn className="w-3.5 h-3.5" />
              Sign in for agent
            </button>
            <button
              onClick={() => void clearSiteSession(rule.id)}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] hover:text-accent-red"
              title="Clear the agent's stored session for this site"
            >
              Clear agent session
            </button>
          </div>
        )}
      </div>

      {confirmingOff && (
        <div className="ml-8 rounded-md border border-accent-orange/40 bg-accent-orange/10 p-2.5 flex flex-col gap-2">
          <div className="text-[11px] text-fg-primary">
            Turning this off revokes the agent's access to your signed-in session. The stored
            session persists on disk until you clear it. Clear it now?
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => confirmOff(true)}
              className="ui-btn ui-btn-primary px-2 py-1 text-[11px]"
            >
              Turn off &amp; clear session
            </button>
            <button
              onClick={() => confirmOff(false)}
              className="ui-btn ui-btn-outline px-2 py-1 text-[11px]"
            >
              Turn off, keep session
            </button>
            <button
              onClick={() => setConfirmingOff(false)}
              className="ui-btn ui-btn-ghost px-2 py-1 text-[11px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── A single agent request row (§18.4) ────────────────────────────────────────
function RequestRow({ request }: { request: AccessRequest }) {
  const decideAccessRequest = useBrowserStore((s) => s.decideAccessRequest);
  const decide = (decision: AccessRequestDecision) => void decideAccessRequest(request.id, decision);

  return (
    <div className="rounded-md border border-accent-orange/50 bg-accent-orange/10 px-3 py-2.5 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Icons.Bot className="w-4 h-4 text-accent-orange shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          {/* Agent title/id render as plain escaped text. */}
          <div className="text-[12px] text-fg-primary">
            <span className="font-semibold">{request.requestedByTitle || 'An agent'}</span>{' '}
            <span className="text-fg-muted">({request.requestedBy})</span> requested access to:
          </div>
          {/* Canonical rule — computed by trusted code, not the agent's raw string. */}
          <div className="text-[12px] font-mono text-fg-secondary mt-0.5">{ruleDescriptor(request)}</div>
          {request.wantSignedIn && (
            <div className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold uppercase tracking-wide text-accent-orange bg-accent-orange/10 px-1.5 py-0.5 rounded">
              <Icons.KeyRound className="w-3 h-3" />
              wants to act while signed in
            </div>
          )}
        </div>
      </div>

      {request.reason && (
        <div className="ml-6 rounded border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] px-2 py-1.5">
          <div className="text-[9px] uppercase tracking-wide font-semibold text-fg-muted mb-0.5">
            agent-provided reason
          </div>
          {/* Untrusted free text — rendered as a plain escaped text child only. */}
          <div className="text-[11px] text-fg-secondary whitespace-pre-wrap break-words">
            “{request.reason}”
          </div>
        </div>
      )}

      <div className="ml-6 flex flex-wrap items-center gap-2">
        <button
          onClick={() => decide('approve')}
          className="ui-btn ui-btn-outline px-2.5 py-1 text-[11px]"
          title="Create a visit-only rule (no signed-in access)"
        >
          <Icons.Check className="w-3.5 h-3.5" />
          Approve (visit)
        </button>
        <button
          onClick={() => decide('approve_signed_in')}
          className="ui-btn px-2.5 py-1 text-[11px] font-semibold bg-accent-orange text-white border border-accent-orange hover:bg-accent-orange/90"
          title="Create the rule AND allow the agent to drive a signed-in session — you still sign in / hand off separately"
        >
          <Icons.KeyRound className="w-3.5 h-3.5" />
          Approve + allow signed in
        </button>
        <button
          onClick={() => decide('deny')}
          className="ui-btn ui-btn-ghost px-2.5 py-1 text-[11px] hover:text-accent-red"
          title="Deny — no rule is created"
        >
          <Icons.X className="w-3.5 h-3.5" />
          Deny
        </button>
      </div>
    </div>
  );
}

// ── Slice 11: idle-discard threshold (memory) ─────────────────────────────────
// How long a background user tab may sit idle before its live WebContentsView is
// discarded (frozen to a snapshot) to save memory. "Never" disables time-based
// discard but keeps the hard live-view cap. Wired straight to setDiscardThreshold
// (minutes → ms, "Never" → null).
const DISCARD_OPTIONS: { label: string; ms: number | null }[] = [
  { label: '15 min', ms: 15 * 60 * 1000 },
  { label: '30 min', ms: 30 * 60 * 1000 },
  { label: '60 min', ms: 60 * 60 * 1000 },
  { label: 'Never', ms: null },
];

function DiscardThresholdSetting() {
  const discardThresholdMs = useBrowserStore((s) => s.discardThresholdMs);
  const setDiscardThreshold = useBrowserStore((s) => s.setDiscardThreshold);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.MoonStar className="w-4 h-4 text-fg-secondary" />
        <h2 className="text-[13px] font-semibold text-fg-primary">Suspend idle tabs</h2>
      </div>
      <p className="text-[11px] text-fg-muted">
        Background tabs left idle this long are suspended to save memory — their content
        reloads the next time you click them. “Never” keeps tabs live (a hard cap still applies).
      </p>
      <div
        role="radiogroup"
        aria-label="Suspend idle tabs after"
        className="flex flex-wrap items-center gap-1.5"
      >
        {DISCARD_OPTIONS.map((opt) => {
          const selected = discardThresholdMs === opt.ms;
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setDiscardThreshold(opt.ms)}
              className={`px-2.5 py-1 text-[11px] rounded border transition-colors ${
                selected
                  ? 'border-accent-blue bg-accent-blue/15 text-fg-primary font-medium'
                  : 'border-tab-border text-fg-secondary hover:bg-[var(--color-tab-hover-bg)]'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function WebsiteAccessSettingsInner() {
  useBrowserSuspension();

  const closeAccessView = useBrowserStore((s) => s.closeAccessView);
  const accessRules = useBrowserStore((s) => s.accessRules);
  const accessRequests = useBrowserStore((s) => s.accessRequests);
  const loadAccessRules = useBrowserStore((s) => s.loadAccessRules);
  const loadAccessRequests = useBrowserStore((s) => s.loadAccessRequests);

  // The allowlist itself is collapsed by default so pending approvals (above)
  // are always visible without scrolling past a long list (§6).
  const [listExpanded, setListExpanded] = useState(false);

  // Refresh on open (the bridge also keeps these live via the change events).
  useEffect(() => {
    void loadAccessRules();
    void loadAccessRequests();
  }, [loadAccessRules, loadAccessRequests]);

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAccessView();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [closeAccessView]);

  const pending = useMemo(
    () => accessRequests.filter((r) => r.status === 'pending'),
    [accessRequests],
  );

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-[var(--color-surface-0)] text-fg-primary">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-browser-divider)] shrink-0">
        <div className="flex items-center gap-2 text-fg-primary">
          <Icons.ShieldCheck className="w-5 h-5" />
          <span className="text-[14px] font-semibold">Website access</span>
        </div>
        <div className="flex-1" />
        <button onClick={closeAccessView} className="ui-btn ui-btn-ghost p-1.5" title="Close">
          <Icons.X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-5">
        {/* ── (1) Pending approvals — prominent, gently pulsing, always on top.
                 Quiet/hidden when empty. ── */}
        {pending.length > 0 && (
          <section className="flex flex-col gap-2 rounded-lg border-2 border-accent-orange/60 bg-accent-orange/5 p-3 animate-pulse">
            <div className="flex items-center gap-2">
              <Icons.BellRing className="w-4 h-4 text-accent-orange" />
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-accent-orange">
                Pending approvals
              </h2>
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-accent-orange text-white">
                {pending.length}
              </span>
            </div>
            <p className="text-[11px] text-fg-muted">
              An agent can request a site, but only your approval here creates a rule — a pending
              request grants zero access.
            </p>
            {/* Inner wrapper stops its content from inheriting the section pulse
                so the request text/buttons stay steady and readable. */}
            <div className="flex flex-col gap-2 [animation:none]">
              {pending.map((r) => (
                <RequestRow key={r.id} request={r} />
              ))}
            </div>
          </section>
        )}

        {/* ── (2) Agent allowlist — collapsed by default; expander reveals a
                 scrollable list (§6). ── */}
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setListExpanded((v) => !v)}
            aria-expanded={listExpanded}
            className="flex items-center gap-2 text-left"
            title={listExpanded ? 'Collapse the allowlist' : 'Expand the allowlist'}
          >
            {listExpanded ? (
              <Icons.ChevronDown className="w-4 h-4 text-fg-secondary" />
            ) : (
              <Icons.ChevronRight className="w-4 h-4 text-fg-secondary" />
            )}
            <Icons.Bot className="w-4 h-4 text-accent-orange" />
            <h2 className="text-[13px] font-semibold text-fg-primary">Agent allowlist</h2>
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-tab-border text-fg-secondary">
              {accessRules.length}
            </span>
          </button>
          <p className="text-[11px] text-fg-muted">
            The only origins agents <span className="font-medium text-fg-secondary">in this
            workspace</span> may visit and drive while Agent Actions is on — everything else is
            denied, and these rules never apply to agents in another workspace. Each row can also
            allow the agent to drive your signed-in session.
          </p>

          {listExpanded && (
            <div className="flex flex-col gap-2">
              <AddRuleForm />
              <div className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto pr-1">
                {accessRules.length === 0 ? (
                  <div className="text-[11px] text-fg-muted px-1 py-2">No allowlist rules yet.</div>
                ) : (
                  accessRules.map((rule) => <RuleRow key={rule.id} rule={rule} />)
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── (3) Memory — idle-tab suspend threshold (Slice 11). ── */}
        <DiscardThresholdSetting />
      </div>
    </div>
  );
}

export default function WebsiteAccessSettings() {
  const accessViewOpen = useBrowserStore((s) => s.accessViewOpen);
  if (!accessViewOpen) return null;
  return <WebsiteAccessSettingsInner />;
}
