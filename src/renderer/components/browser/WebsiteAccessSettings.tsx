import React, { useEffect, useMemo, useState } from 'react';
import * as Icons from 'lucide-react';
import {
  useBrowserStore,
  type AccessRequest,
  type AccessRequestDecision,
  type AccessRule,
  type AccessRuleInput,
  type AccessSiteStatus,
  type HandedTabInfo,
  type SignedInOrigin,
} from '../../stores/browser-store';
import { useDashboardStore } from '../../stores/dashboard-store';
import { useBrowserSuspension } from './useBrowserSuspension';

// ── Relative "x ago" label (trusted-chrome only; epoch ms in, short label out).
// Used by the session center ("signed in 3d ago · last used 2h ago") and the
// pending-approval rows (request age). null/undefined → "unknown".
function relTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return 'unknown';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

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

// ── Phase 3 (§D line 259): the FIVE-word status vocabulary ────────────────────
// Combines each row's visit permission with its WORKSPACE-EXACT login-grant state
// into the exact labels a non-engineer reads at a glance — Visit allowed / Login
// off / Setup required / Ready / Needs sign-in. `session` is the workspace-exact
// grant runtime state from AccessSiteStatus (never a bare legacy row — line 264).
type AccessSiteSession = AccessSiteStatus['session'];

/** The login-status chip label for a row given its grant `login` + `session`. */
function loginStatusLabel(login: boolean, session: AccessSiteSession): string {
  if (!login) return 'Login off';
  if (session === 'active') return 'Ready';
  if (session === 'expired') return 'Needs sign-in';
  return 'Setup required'; // 'setup_required' | 'none' (login on, no active grant yet)
}

/** The SINGLE contextual action label for an allow_signed_in row (line 260):
 *  active → Turn off; expired → Re-authenticate; otherwise → Set up. */
function loginActionLabel(session: AccessSiteSession): 'Turn off' | 'Re-authenticate' | 'Set up' {
  if (session === 'active') return 'Turn off';
  if (session === 'expired') return 'Re-authenticate';
  return 'Set up';
}

/** Chip tint for a login-status label (Ready green / Needs sign-in red /
 *  Setup required amber / Login off muted). */
function loginChipClass(label: string): string {
  switch (label) {
    case 'Ready':
      return 'bg-accent-green/15 text-accent-green';
    case 'Needs sign-in':
      return 'bg-accent-red/15 text-accent-red';
    case 'Setup required':
      return 'bg-accent-orange/15 text-accent-orange';
    default:
      return 'bg-tab-border text-fg-muted'; // Login off
  }
}

// ── Signed-in capability: the 4-point consent gate (WI-5) ─────────────────────
// EVERY path that grants `allow_signed_in` (the per-row toggle AND the
// access-request "Approve + allow signed in") routes through this dialog FIRST,
// so the durable `consent_acked_at` stamp can never be created without the human
// acknowledging what sharing a signed-in session means. It is a one-time gate
// (consent is durable on the rule) — the JIT banner shown later is a reminder,
// not a re-consent. `label` names the origin the capability applies to.
function SignedInConsentDialog({
  label,
  workspaceLabel,
  onAcknowledge,
  onCancel,
}: {
  label: string;
  workspaceLabel: string;
  onAcknowledge: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="ml-8 rounded-md border border-accent-orange/50 bg-accent-orange/10 p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.KeyRound className="w-4 h-4 text-accent-orange shrink-0" />
        <div className="text-[12px] font-semibold text-fg-primary">
          Allow agents to use a signed-in session on{' '}
          <span className="font-mono">{label}</span>?
        </div>
      </div>
      {/* Phase 3 (§D line 263): the grant is workspace-exact — name the workspace
          it applies to on every consent surface. */}
      <div className="text-[11px] text-fg-secondary">
        Workspace: <span className="font-semibold text-fg-primary">{workspaceLabel}</span>
      </div>
      <ul className="list-disc pl-6 space-y-0.5 text-[11px] text-fg-secondary">
        <li>This session is shared by every agent in this workspace.</li>
        <li>It persists across app restarts.</li>
        <li>It stays durable until you sign out of the site or clear the session.</li>
        <li>This is the agent browser — not your private/personal browser.</li>
        <li>
          Turning this on will <strong>copy your current login for this site</strong> from your own
          browser into the agents' shared session (cookie-based — sites that store login outside
          cookies, e.g. Google SSO, may still need the Sign-in path).
        </li>
      </ul>
      <div className="flex items-center gap-2">
        <button
          onClick={onAcknowledge}
          className="ui-btn px-3 py-1 text-[11px] font-semibold bg-accent-orange text-white border border-accent-orange hover:bg-accent-orange/90"
        >
          <Icons.Check className="w-3.5 h-3.5" />
          I understand — allow signed-in
        </button>
        <button onClick={onCancel} className="ui-btn ui-btn-ghost px-3 py-1 text-[11px]">
          Cancel
        </button>
      </div>
    </div>
  );
}

// Login-URL patterns are GLOB or plain SUBSTRING only — never arbitrary regex
// (plans/SignedInTabs_Implementation.md WI-2(c)/WI-5). Reject any line carrying a
// regex metacharacter so a typo'd pattern can't silently become a catch-all (or
// a ReDoS) on the main-side warm-expiry heuristic. `*`/`?` are allowed as glob
// wildcards. Returns an error string for the first bad line, or null if all OK.
const REGEX_METACHARS = /[\\^$+|()[\]{}]/;
export function validateLoginUrlPatterns(lines: string[]): string | null {
  for (const raw of lines) {
    const p = raw.trim();
    if (!p) continue;
    if (p.length > 200) return `Pattern "${p.slice(0, 24)}…" is too long.`;
    if (REGEX_METACHARS.test(p)) {
      return `"${p}" looks like a regular expression — use a glob (*) or a plain substring instead.`;
    }
  }
  return null;
}

/** Split a textarea value into trimmed, non-empty pattern lines. */
export function parseLoginUrlPatterns(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// ── Per-rule login-URL patterns editor (WI-5) ─────────────────────────────────
// An optional, collapsed-by-default textarea (one glob/substring per line) that
// tunes the main-side warm-expiry heuristic for false-positive-prone SSO / job
// boards. The default heuristic runs everywhere; these only EXTEND it. The UI
// validates aggressively (no arbitrary regex) before persisting.
function LoginUrlPatternsEditor({ rule }: { rule: AccessRule }) {
  const updateAccessRule = useBrowserStore((s) => s.updateAccessRule);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(() => (rule.loginUrlPatterns ?? []).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const count = rule.loginUrlPatterns?.length ?? 0;

  const save = () => {
    const patterns = parseLoginUrlPatterns(text);
    const err = validateLoginUrlPatterns(patterns);
    if (err) {
      setError(err);
      setSaved(false);
      return;
    }
    setError(null);
    setSaved(true);
    void updateAccessRule(rule.id, { loginUrlPatterns: patterns });
  };

  return (
    <div className="pl-8 flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-left text-[11px] text-fg-secondary hover:text-fg-primary"
        title="Tune which URLs count as a login wall for this site"
      >
        {open ? (
          <Icons.ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <Icons.ChevronRight className="w-3.5 h-3.5" />
        )}
        Login-URL patterns
        {count > 0 && (
          <span className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full text-[9px] font-bold bg-tab-border text-fg-secondary">
            {count}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] text-fg-muted">
            One glob or substring per line (e.g. <span className="font-mono">*/candidate/*</span> or{' '}
            <span className="font-mono">/sso</span>). Wildcards <span className="font-mono">*</span>{' '}
            and <span className="font-mono">?</span> are allowed — regular expressions are not.
          </div>
          <textarea
            value={text}
            spellCheck={false}
            rows={3}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setSaved(false);
            }}
            placeholder={'*/login*\n/sso'}
            className="w-full bg-[var(--color-surface-0)] border border-tab-border px-2 py-1.5 text-[11px] font-mono text-fg-primary placeholder-fg-muted focus:outline-none focus:border-accent-blue/60 resize-y"
          />
          {error && (
            <div className="flex items-center gap-1.5 text-[11px] text-accent-red">
              <Icons.AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <button onClick={save} className="ui-btn ui-btn-outline px-2 py-1 text-[11px]">
              Save patterns
            </button>
            {saved && !error && (
              <span className="inline-flex items-center gap-1 text-[10px] text-accent-green">
                <Icons.Check className="w-3 h-3" />
                Saved
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
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
function RuleRow({
  rule,
  status,
  workspaceLabel,
}: {
  rule: AccessRule;
  status?: AccessSiteStatus;
  workspaceLabel: string;
}) {
  const updateAccessRule = useBrowserStore((s) => s.updateAccessRule);
  const removeAccessRule = useBrowserStore((s) => s.removeAccessRule);
  const beginSigninHandoff = useBrowserStore((s) => s.beginSigninHandoff);
  const clearSiteSession = useBrowserStore((s) => s.clearSiteSession);
  const grantSignedInConsent = useBrowserStore((s) => s.grantSignedInConsent);
  const importUserSession = useBrowserStore((s) => s.importUserSession);

  const [confirmingOff, setConfirmingOff] = useState(false);
  // WI-5: turning the capability ON routes through the 4-point consent first.
  const [consenting, setConsenting] = useState(false);

  // Phase 3 (§D lines 259-260/264): the row's combined vocabulary + single
  // contextual action derive from the WORKSPACE-EXACT status seam (never a bare
  // row). Fall back to the rule's own fields before the first status load.
  const login = status?.login ?? rule.allowSignedIn;
  const session: AccessSiteSession = status?.session ?? 'none';
  const loginLabel = loginStatusLabel(login, session);
  const actionLabel = loginActionLabel(session);

  const toggleSignedIn = () => {
    if (rule.allowSignedIn) {
      // Turning OFF revokes the capability; offer to clear the stored session
      // (no silent auto-clear — §15/Q5).
      setConfirmingOff(true);
    } else {
      // Turning ON must not persist `allow_signed_in` until the human
      // acknowledges the 4-point consent (which stamps consent_acked_at).
      setConsenting(true);
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
          {/* Phase 3 (§D line 259): combined visit + login status at a glance. An
              enabled rule shows "Visit allowed"; a disabled one relies on the
              line-through descriptor above (no invented word). */}
          <div className="flex flex-wrap items-center gap-1.5 mt-1">
            {rule.enabled && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent-blue/15 text-accent-blue">
                <Icons.Globe className="w-3 h-3" />
                Visit allowed
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${loginChipClass(loginLabel)}`}
            >
              <Icons.KeyRound className="w-3 h-3" />
              {loginLabel}
            </span>
          </div>
        </div>
        <button
          onClick={() => void removeAccessRule(rule.id)}
          className="ui-btn ui-btn-ghost p-1 shrink-0 hover:text-accent-red"
          title="Delete rule"
        >
          <Icons.Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Phase 3 (§D line 260): ONE "Agents may use my login" toggle + ONE
          contextual action (Set up / Re-authenticate / Turn off). */}
      <div className="flex items-start gap-2 pl-8">
        <button
          type="button"
          role="switch"
          aria-checked={rule.allowSignedIn}
          aria-label="Agents may use my login"
          onClick={toggleSignedIn}
          className="shrink-0 mt-0.5"
          title="Let agents in this workspace use your signed-in session for this site"
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
          <div className="text-[11px] text-fg-secondary">Agents may use my login</div>
          <div className="text-[10px] text-fg-muted">
            Lets agents drive your signed-in session here; shared by every agent in{' '}
            <span className="font-medium text-fg-secondary">{workspaceLabel}</span>; persists until
            you clear it.
          </div>
        </div>
        {rule.allowSignedIn && (
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Single contextual action, label derived from the workspace-exact
                grant state (line 260). "Turn off" reuses the confirm-off dialog;
                Set up / Re-authenticate open the quarantined setup tab. */}
            <button
              onClick={() =>
                actionLabel === 'Turn off'
                  ? setConfirmingOff(true)
                  : void beginSigninHandoff(rule)
              }
              className={`ui-btn px-2 py-1 text-[11px] ${
                actionLabel === 'Turn off' ? 'ui-btn-ghost hover:text-accent-red' : 'ui-btn-outline'
              }`}
              title={
                actionLabel === 'Turn off'
                  ? "Turn off agents' access to your signed-in session for this site"
                  : 'Open a quarantined login tab so you can sign in for the agent'
              }
            >
              {actionLabel !== 'Turn off' && <Icons.LogIn className="w-3.5 h-3.5" />}
              {actionLabel}
            </button>
          </div>
        )}
      </div>

      {/* WI-5: the 4-point consent gate, shown before the capability persists. */}
      {consenting && (
        <SignedInConsentDialog
          label={ruleDescriptor(rule)}
          workspaceLabel={workspaceLabel}
          onAcknowledge={() => {
            setConsenting(false);
            void (async () => {
              await grantSignedInConsent(rule.id);
              // WI-E: the user's mental model is "toggling it on pulled my
              // credentials" — auto-attempt the import once consent is granted +
              // allowSignedIn persisted. Best-effort; never blocks the toggle.
              void importUserSession(rule.id);
            })();
          }}
          onCancel={() => setConsenting(false)}
        />
      )}

      {/* WI-5: per-rule login-URL patterns — only meaningful once signed-in is on. */}
      {rule.allowSignedIn && <LoginUrlPatternsEditor rule={rule} />}

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
function RequestRow({
  request,
  workspaceLabel,
}: {
  request: AccessRequest;
  workspaceLabel: string;
}) {
  const decideAccessRequest = useBrowserStore((s) => s.decideAccessRequest);
  const approveSignedInWithConsent = useBrowserStore((s) => s.approveSignedInWithConsent);
  const beginSigninHandoff = useBrowserStore((s) => s.beginSigninHandoff);
  const decide = (decision: AccessRequestDecision) => void decideAccessRequest(request.id, decision);

  // WI-5: "Approve + allow signed in" must route through the SAME 4-point consent
  // as the toggle — approving an agent request can't mint signed-in capability
  // without it. The plain "Approve (visit)" / "Deny" paths are unchanged.
  const [consenting, setConsenting] = useState(false);

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
          {/* Request age — how long this has been waiting on a human. */}
          <div className="text-[10px] text-fg-muted">requested {relTime(request.createdAt)}</div>
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
          onClick={() => setConsenting(true)}
          className="ui-btn px-2.5 py-1 text-[11px] font-semibold bg-accent-orange text-white border border-accent-orange hover:bg-accent-orange/90"
          title="Create the rule, allow signed-in access, AND open the setup tab so you can sign in now"
        >
          <Icons.KeyRound className="w-3.5 h-3.5" />
          Allow visit and set up login
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

      {consenting && (
        <SignedInConsentDialog
          label={ruleDescriptor(request)}
          workspaceLabel={workspaceLabel}
          onAcknowledge={() => {
            setConsenting(false);
            // Phase 3 (§D line 261): approval flows STRAIGHT into the quarantined
            // setup tab — the human doesn't have to hunt for a second button.
            void (async () => {
              const created = await approveSignedInWithConsent(request);
              if (created) await beginSigninHandoff(created);
            })();
          }}
          onCancel={() => setConsenting(false)}
        />
      )}
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

// ── Slice 12: "Sessions shared with agents" (handoff / session center) ────────
// A read-out of what the agent can currently use on the human's behalf:
//   • live HANDED tabs (Mechanism B) — the agent is driving a real signed-in
//     tab right now; one-click "Return tab" revokes it;
//   • persisted SIGNED-IN origins (Mechanism A) — authenticated sessions stored
//     for the agent, each with "signed in <age> · last used <age>" and per-row
//     "Clear site session" (confirmed) + "Disable signed-in access".
// A stale/expired origin surfaces an amber "Session may have expired —
// re-sign-in" chip wired to the same beginSigninHandoff() flow used elsewhere.

function HandedTabRow({ tab }: { tab: HandedTabInfo }) {
  const tabReturnToHuman = useBrowserStore((s) => s.tabReturnToHuman);
  let host = tab.url;
  try {
    host = new URL(tab.url).host || tab.url;
  } catch {
    /* keep raw */
  }
  return (
    <div className="rounded-md border border-accent-orange/40 bg-accent-orange/5 px-3 py-2 flex items-center gap-3">
      <Icons.Bot className="w-4 h-4 text-accent-orange shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-fg-primary truncate">{tab.title || host}</div>
        <div className="text-[10px] text-fg-muted font-mono truncate">{host}</div>
      </div>
      <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide bg-accent-orange/15 text-accent-orange">
        <Icons.Bot className="w-2.5 h-2.5" />
        Agent driving
      </span>
      <button
        onClick={() => void tabReturnToHuman(tab.tabId)}
        className="ui-btn ui-btn-outline px-2 py-1 text-[11px] shrink-0"
        title="Stop the agent driving this tab and take it back"
      >
        <Icons.Undo2 className="w-3.5 h-3.5" />
        Return tab
      </button>
    </div>
  );
}

function SignedInOriginRow({ origin }: { origin: SignedInOrigin }) {
  const accessRules = useBrowserStore((s) => s.accessRules);
  const clearSiteSession = useBrowserStore((s) => s.clearSiteSession);
  const updateAccessRule = useBrowserStore((s) => s.updateAccessRule);
  const beginSigninHandoff = useBrowserStore((s) => s.beginSigninHandoff);
  const importUserSession = useBrowserStore((s) => s.importUserSession);

  // Asymmetric confirmation (mirror of the allowSignedIn ON→OFF flow): the
  // destructive clear requires an explicit confirm, cancel is the easy path.
  const [confirmingClear, setConfirmingClear] = useState(false);
  // WI-E: the quiet "no saved login found" notice shown after an import that
  // copied zero cookies (the row stays never/expired and falls back to Sign in).
  const [importNotice, setImportNotice] = useState(false);

  // Proactive-signin (2026-06-29): three lifecycle states. Fall back to the
  // legacy `stale` flag when an older payload omits `state` so this row stays
  // correct against a not-yet-upgraded main process.
  const rowState: 'signed_in' | 'expired' | 'never' =
    origin.state ?? (origin.stale ? 'expired' : 'signed_in');
  const neverSignedIn = rowState === 'never';

  const signIn = () => {
    // Reuse the persisted rule when present so the hand-off carries its real
    // identity; fall back to a minimal shape (id + hostname are all the flow
    // needs) if the rule list hasn't loaded the row yet.
    const rule =
      accessRules.find((r) => r.id === origin.ruleId) ??
      ({ id: origin.ruleId, hostname: origin.hostname } as AccessRule);
    void beginSigninHandoff(rule);
  };

  // WI-E "Import my session": copy the human's existing login for this site from
  // their own browser (persist:user) into the agents' shared session. On a
  // zero-cookie result the row stays as-is and we surface the Sign-in fallback.
  const importSession = async () => {
    setImportNotice(false);
    const result = await importUserSession(origin.ruleId);
    // Phase 2 (§D line 245): candidateCookiesCopied is the count of cookies staged
    // for setup — zero means nothing to import, so surface the Sign-in fallback.
    if (result.candidateCookiesCopied === 0) setImportNotice(true);
  };

  return (
    <div className="rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] px-3 py-2 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Icons.KeyRound
          className={`w-4 h-4 shrink-0 ${rowState === 'signed_in' ? 'text-accent-green' : 'text-accent-orange'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-mono text-fg-primary truncate">{origin.hostname}</div>
          <div
            className={`text-[10px] ${rowState === 'signed_in' ? 'text-accent-green' : 'text-fg-muted'}`}
          >
            {neverSignedIn ? (
              'Not signed in'
            ) : (
              <>signed in {relTime(origin.signedInAt)} · last used {relTime(origin.lastUsedAt)}</>
            )}
          </div>
        </div>
        {(neverSignedIn || rowState === 'expired') && (
          <button
            onClick={() => void importSession()}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border border-accent-orange bg-accent-orange/15 text-accent-orange hover:bg-accent-orange/25"
            title="Copy your current login for this site from your own browser into the agents' shared session (a point-in-time snapshot)"
          >
            <Icons.Download className="w-3.5 h-3.5" />
            Import my session
          </button>
        )}
        {neverSignedIn && (
          <button
            onClick={signIn}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold border border-accent-orange/60 bg-accent-orange/10 text-accent-orange hover:bg-accent-orange/20"
            title="Open a tab to sign in once — every agent in this workspace inherits the session"
          >
            <Icons.LogIn className="w-3.5 h-3.5" />
            Sign in
          </button>
        )}
        {rowState === 'expired' && (
          <button
            onClick={signIn}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border border-accent-orange/60 bg-accent-orange/10 text-accent-orange hover:bg-accent-orange/20"
            title="This stored session looks stale — sign in again to refresh it"
          >
            <Icons.AlertTriangle className="w-3 h-3" />
            Session may have expired — re-sign-in
          </button>
        )}
      </div>

      {importNotice && (
        <div className="ml-7 text-[10px] text-fg-muted">
          No saved login found in your browser for this site — click Sign in to log in inside an
          agent tab.
        </div>
      )}

      <div className="flex items-center gap-2 pl-7">
        <button
          onClick={() => void updateAccessRule(origin.ruleId, { allowSignedIn: false })}
          className="ui-btn ui-btn-outline px-2 py-1 text-[11px]"
          title="Stop the agent from using a signed-in session here (the rule stays, visit-only)"
        >
          <Icons.ShieldOff className="w-3.5 h-3.5" />
          Disable signed-in access
        </button>
        {!neverSignedIn && (
          <button
            onClick={() => setConfirmingClear(true)}
            className="ui-btn ui-btn-ghost px-2 py-1 text-[11px] hover:text-accent-red"
            title="Wipe the agent's stored session for this site"
          >
            <Icons.Trash2 className="w-3.5 h-3.5" />
            Clear site session
          </button>
        )}
      </div>

      {confirmingClear && (
        <div className="ml-7 rounded-md border border-accent-red/40 bg-accent-red/10 p-2.5 flex flex-col gap-2">
          <div className="text-[11px] text-fg-primary">
            Clear the agent's stored session for{' '}
            <span className="font-mono">{origin.hostname}</span>? The agent will be signed out and
            you'll need to sign in again to re-share it.
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setConfirmingClear(false);
                void clearSiteSession(origin.ruleId);
              }}
              className="ui-btn px-2 py-1 text-[11px] font-semibold bg-accent-red text-white border border-accent-red hover:bg-accent-red/90"
            >
              Clear session
            </button>
            <button
              onClick={() => setConfirmingClear(false)}
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

function SessionsSharedSection() {
  const sharedSessions = useBrowserStore((s) => s.sharedSessions);
  const { handedTabs, signedInOrigins } = sharedSessions;
  const total = handedTabs.length + signedInOrigins.length;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.Share2 className="w-4 h-4 text-accent-orange" />
        <h2 className="text-[13px] font-semibold text-fg-primary">Sessions shared with agents</h2>
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold bg-tab-border text-fg-secondary">
          {total}
        </span>
      </div>
      <p className="text-[11px] text-fg-muted">
        Tabs an agent is driving right now, and the signed-in sessions stored for agents in this
        workspace. Return a tab, clear a stored session, or revoke signed-in access at any time.
      </p>

      {total === 0 ? (
        <div className="text-[11px] text-fg-muted px-1 py-2">
          No tabs handed to an agent and no signed-in sessions shared.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {handedTabs.map((tab) => (
            <HandedTabRow key={tab.tabId} tab={tab} />
          ))}
          {signedInOrigins.map((origin) => (
            <SignedInOriginRow key={`${origin.ruleId}:${origin.origin}`} origin={origin} />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Signed-in sign-in config (WI-8) ───────────────────────────────────────────
// The JIT sign-in hold timeout (how long a quarantined login tab waits for the
// human before the agent degrades to a block-stub) + the per-workspace
// "unattended" flag (overnight runs skip the tab and degrade immediately). Both
// round-trip through the manager (authoritative); these mirror its state.
const HOLD_TIMEOUT_OPTIONS: { label: string; ms: number }[] = [
  { label: '1 min', ms: 60 * 1000 },
  { label: '3 min', ms: 3 * 60 * 1000 },
  { label: '5 min', ms: 5 * 60 * 1000 },
  { label: '10 min', ms: 10 * 60 * 1000 },
];

function SigninConfigSetting() {
  const holdMs = useBrowserStore((s) => s.signinHoldTimeoutMs);
  const unattended = useBrowserStore((s) => s.signinUnattended);
  const setHold = useBrowserStore((s) => s.setSigninHoldTimeoutMs);
  const setUnattended = useBrowserStore((s) => s.setSigninUnattended);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Icons.UserCheck className="w-4 h-4 text-fg-secondary" />
        <h2 className="text-[13px] font-semibold text-fg-primary">Agent sign-in</h2>
      </div>
      <p className="text-[11px] text-fg-muted">
        When an agent hits a site that needs you signed in, a login tab opens and the agent waits.
        If you don’t finish within this window, the agent treats the site as blocked and moves on.
      </p>
      <div
        role="radiogroup"
        aria-label="Sign-in hold timeout"
        className="flex flex-wrap items-center gap-1.5"
      >
        {HOLD_TIMEOUT_OPTIONS.map((opt) => {
          const selected = holdMs === opt.ms;
          return (
            <button
              key={opt.label}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => void setHold(opt.ms)}
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
      <label className="flex items-start gap-2 text-[11px] text-fg-secondary cursor-pointer mt-1">
        <input
          type="checkbox"
          checked={unattended}
          onChange={(e) => void setUnattended(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-fg-primary">Unattended runs</span> — don’t open a login
          tab; sites needing sign-in are treated as blocked immediately. Use this for overnight runs
          when no one is here to sign in.
        </span>
      </label>
    </section>
  );
}

function WebsiteAccessSettingsInner() {
  useBrowserSuspension();

  const closeAccessView = useBrowserStore((s) => s.closeAccessView);
  const accessRules = useBrowserStore((s) => s.accessRules);
  const accessRequests = useBrowserStore((s) => s.accessRequests);
  const siteStatus = useBrowserStore((s) => s.siteStatus);
  const loadAccessRules = useBrowserStore((s) => s.loadAccessRules);
  const loadSiteStatus = useBrowserStore((s) => s.loadSiteStatus);
  const loadAccessRequests = useBrowserStore((s) => s.loadAccessRequests);
  const loadSharedSessions = useBrowserStore((s) => s.loadSharedSessions);
  const loadSigninConfig = useBrowserStore((s) => s.loadSigninConfig);

  // Phase 3 (§D line 263): name the exact workspace on the consent/setup surfaces.
  // `Workspace.title` is the display name (there is no `.name`); default store
  // state (no workspaces / null selection) → "the default workspace".
  const workspaceLabel = useDashboardStore(
    (s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.title ?? 'the default workspace',
  );

  // Phase 3 (§D line 258): the allowlist is EXPANDED by default so a non-engineer
  // can answer "which sites may agents visit / use my login?" from the first
  // screen. The collapse toggle stays (harmless).
  const [listExpanded, setListExpanded] = useState(true);
  // Phase 3 (§D line 262): Advanced & Activity (live handed tabs, JIT timeout,
  // unattended, session age, idle-tab suspend) is collapsed by default so it is
  // off the primary at-a-glance surface.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Proactive-signin (2026-06-29) WI-C: case-insensitive substring filter over
  // the allowlist rows (hostname / path-prefix / note). Empty = show all.
  const [ruleSearch, setRuleSearch] = useState('');
  const filteredRules = useMemo(() => {
    const q = ruleSearch.trim().toLowerCase();
    if (!q) return accessRules;
    return accessRules.filter(
      (r) =>
        r.hostname.toLowerCase().includes(q) ||
        (r.pathPrefix ?? '').toLowerCase().includes(q) ||
        (r.note ?? '').toLowerCase().includes(q),
    );
  }, [accessRules, ruleSearch]);

  // Refresh on open (the bridge also keeps these live via the change events).
  useEffect(() => {
    void loadAccessRules();
    void loadSiteStatus();
    void loadAccessRequests();
    void loadSharedSessions();
    void loadSigninConfig();
  }, [loadAccessRules, loadSiteStatus, loadAccessRequests, loadSharedSessions, loadSigninConfig]);

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
    <div className="browser-overlay-anim absolute inset-0 z-40 flex flex-col bg-[var(--color-surface-0)] text-fg-primary">
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
                <RequestRow key={r.id} request={r} workspaceLabel={workspaceLabel} />
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
              {/* WI-C: filter the rows by hostname / path / note. */}
              {accessRules.length > 0 && (
                <div className="relative">
                  <Icons.Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-muted" />
                  <input
                    type="text"
                    value={ruleSearch}
                    onChange={(e) => setRuleSearch(e.target.value)}
                    aria-label="Search allowlist"
                    placeholder="Search sites…"
                    className="w-full rounded-md border border-[var(--color-browser-divider)] bg-[var(--color-surface-0)] pl-7 pr-2 py-1 text-[12px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:border-accent-orange/60"
                  />
                </div>
              )}
              <div className="flex flex-col gap-2 max-h-[55vh] overflow-y-auto pr-1">
                {accessRules.length === 0 ? (
                  <div className="text-[11px] text-fg-muted px-1 py-2">No allowlist rules yet.</div>
                ) : filteredRules.length === 0 ? (
                  <div className="text-[11px] text-fg-muted px-1 py-2">
                    No rules match “{ruleSearch.trim()}”.
                  </div>
                ) : (
                  filteredRules.map((rule) => (
                    <RuleRow
                      key={rule.id}
                      rule={rule}
                      status={siteStatus.find((s) => s.ruleId === rule.id)}
                      workspaceLabel={workspaceLabel}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── (3) Advanced & Activity — collapsed by default (Phase 3 §D line
                 262). Moves live handed tabs, JIT timeout, unattended, session
                 age, and idle-tab suspend off the primary at-a-glance surface. ── */}
        <section className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-2 text-left"
            title={advancedOpen ? 'Collapse Advanced & Activity' : 'Expand Advanced & Activity'}
          >
            {advancedOpen ? (
              <Icons.ChevronDown className="w-4 h-4 text-fg-secondary" />
            ) : (
              <Icons.ChevronRight className="w-4 h-4 text-fg-secondary" />
            )}
            <Icons.SlidersHorizontal className="w-4 h-4 text-fg-secondary" />
            <h2 className="text-[13px] font-semibold text-fg-primary">Advanced &amp; Activity</h2>
          </button>
          <p className="text-[11px] text-fg-muted">
            Live handed tabs, agent sign-in timing, and idle-tab memory settings.
          </p>

          {advancedOpen && (
            <div className="flex flex-col gap-5">
              {/* Sessions shared with agents — handed tabs + signed-in origins (Slice 12). */}
              <SessionsSharedSection />

              {/* Agent sign-in — JIT hold timeout + unattended flag (WI-8). */}
              <SigninConfigSetting />

              {/* Memory — idle-tab suspend threshold (Slice 11). */}
              <DiscardThresholdSetting />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function WebsiteAccessSettings() {
  const accessViewOpen = useBrowserStore((s) => s.accessViewOpen);
  if (!accessViewOpen) return null;
  return <WebsiteAccessSettingsInner />;
}
