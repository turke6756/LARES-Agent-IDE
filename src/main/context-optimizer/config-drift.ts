// config-drift.ts — A5 static per-lane toolset drift check (design §5.2 A5,
// master-implementation ~L392, hardening-epochs-outcomes §3.4).
//
// A deterministic, LOG-FREE cross-join of three per-lane sets:
//
//   DOCUMENTED  — what a lane's persona/config PREDICTS it will invoke. Compiler
//                 `PredictedAction`s of kind 'toolset-usage' (params.toolset) and
//                 the sibling 'tool-invocation's (params.toolName) from the SAME
//                 source node (guidance-action-model groups an `mcp:` node into one
//                 toolset-usage + one tool-invocation per member; they share a
//                 `source` anchor — that is how we re-associate toolset↔members here
//                 without the action carrying its toolset).
//   GRANTED     — what the lane actually launches with. `toolsetsForLane`
//                 (mcp-config-builder.ts) — the CSV of toolset keys injected inline
//                 at spawn. Injected as a seam (default wiring passes toolsetsForLane
//                 verbatim; we accept its raw CSV string OR a pre-split list).
//   REGISTERED  — what live toolset defs actually exist. `makeToolsetDefsProvider`
//                 (context-overhead/ipc-deps): the set of toolset keys + each key's
//                 live member tool names. Injected as a seam.
//
// Emits three drift kinds (each a pure static FACT, hence `observed-safe` by
// construction — see attribution.ts, where `observed-safe` == a lane-level tool-grant
// signal; there is NO behavioral inference here, so no exposure floor and no
// shared-cwd caveat apply):
//
//   documented-but-not-granted     — a lane's config documents a toolset it is NOT
//                                     granted (the notebook-in-worker-persona case:
//                                     QW1 trimmed `notebooks` from the worker grant
//                                     but a persona line still reaches for it → the
//                                     doc is dead / the grant is missing).
//   granted-but-undocumented       — a lane is granted a toolset nothing documents
//                                     (rent with no documented purpose — a trim
//                                     candidate).
//   documented-but-decommissioned  — a documented toolset (or a documented member
//                                     tool) no longer exists in the live defs (the
//                                     team-member-tools case: `teams` is registered
//                                     but several member tools are decommissioned).
//                                     Registration is grant-independent, so this fires
//                                     even for an ungranted toolset.
//
// Pure over (actions, injected deps). Deterministic: stable ordering, no clocks, no
// DB handle, no filesystem. Reuses PredictedAction (§5.1) and BehaviorEvidenceTier
// (shared/types); does NOT re-derive lane inheritance (that is action.lanes, the
// module-1 union carried by the compiler).

import type { AgentRoleLane, BehaviorEvidenceTier, PersonaLane } from '../../shared/types';
import type { PredictedAction } from './guidance-action-model';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type DriftKind =
  | 'documented-but-not-granted'
  | 'granted-but-undocumented'
  | 'documented-but-decommissioned'
  // WP-2A: a resident markdown tool mention that could NOT be resolved to a single
  // toolset — either ambiguous (name in multiple toolsets) or unresolved (name in no
  // REGISTERED toolset). NEVER a subtract; the engine turns it into a typed
  // grant-mismatch-evaluation diagnostic (ambiguous-toolset / unresolved-documentation)
  // so the suppression is auditable rather than silent.
  | 'documented-unresolved-toolset';

export interface SourceAnchor {
  absPath: string;
  line: number;
}

export interface DriftFinding {
  kind: DriftKind;
  /** The lane the finding is scoped to (drift is always per-lane). */
  lane: PersonaLane;
  /** The toolset key in question. For `documented-unresolved-toolset` this is the
   *  mentioned tool name (there is no single resolved toolset), so the id/panel key
   *  stays granular. */
  toolset: string;
  /** Set only for member-tool decommission findings (the tool that vanished). */
  toolName?: string;
  /** Always `observed-safe`: a static config fact, not a behavior inference (§5.2). */
  evidenceTier: BehaviorEvidenceTier;
  /** Human-readable one-liner for the drift panel. */
  detail: string;
  /** Documented `{absPath,line}` anchors backing the finding. Empty for
   *  `granted-but-undocumented` (a grant has no source line in the persona). */
  sources: SourceAnchor[];
  // ── WP-2A provenance (resolution of a resident markdown tool mention). ──
  /** The code-form tool name mentioned in resident markdown (resolution input). */
  mentionedToolName?: string;
  /** How the toolset was resolved — a `code-name` match is the only observed-safe basis
   *  for a subtract; `heading` stays inferred/human-review. Absent for legacy `mcp:`
   *  toolset-usage documentation (already toolset-granular). */
  resolutionConfidence?: 'code-name' | 'heading';
  /** `documented-unresolved-toolset` (ambiguous): every toolset the name resolved to. */
  candidateToolsets?: string[];
}

export interface ConfigDriftDeps {
  /** GRANTED: a lane's toolset grant. Default wiring passes `toolsetsForLane`
   *  (mcp-config-builder), which returns a CSV string — we accept that raw, or a
   *  pre-split list. Empty / whitespace entries are dropped. */
  grantedToolsetsFor: (lane: PersonaLane) => string | readonly string[];
  /** REGISTERED: the set of live toolset keys (`makeToolsetDefsProvider`'s script
   *  map keys). A documented toolset absent here is decommissioned wholesale. */
  registeredToolsets: () => readonly string[];
  /** REGISTERED: a toolset's live member tool names, or `null` when the toolset key
   *  is not registered. A documented member tool absent from a REGISTERED toolset's
   *  list is a decommissioned member. */
  registeredToolNamesFor: (toolset: string) => readonly string[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The static, log-free evidence tier every drift finding carries. Minted directly
 *  (not via scoreAttribution, which needs an OccurrenceVerdict we deliberately don't
 *  have): a config cross-join is a lane-level tool-grant fact, the strongest tier. */
const DRIFT_TIER: BehaviorEvidenceTier = 'observed-safe';

/** The three grant-bearing lanes. `legacy` carries no toolset grant (''), so it is
 *  never a drift subject; a documented action tagged `legacy` is simply skipped. */
const GRANT_LANES: readonly PersonaLane[] = ['supervisor', 'worker', 'researcher'];
const GRANT_LANE_SET: ReadonlySet<AgentRoleLane> = new Set<AgentRoleLane>(GRANT_LANES);

const DRIFT_ORDER: Record<DriftKind, number> = {
  'documented-but-not-granted': 0,
  'documented-but-decommissioned': 1,
  'granted-but-undocumented': 2,
  'documented-unresolved-toolset': 3,
};

/** Normalize a grant (CSV string or list) → deduped, ordered toolset-key set. */
function grantSet(raw: string | readonly string[]): Set<string> {
  const parts = typeof raw === 'string' ? raw.split(',') : raw;
  const out = new Set<string>();
  for (const p of parts) {
    const t = p.trim();
    if (t) out.add(t);
  }
  return out;
}

function anchorKey(a: SourceAnchor): string {
  return `${a.absPath}:${a.line}`;
}

/** A documented toolset grant, re-associated from the compiler's action stream: one
 *  toolset key, the lanes that documented it, its documented member tools, and the
 *  source anchors backing each. */
interface DocumentedGrant {
  toolset: string;
  /** lane → the source anchors (in that lane) that documented this toolset. */
  lanesToSources: Map<PersonaLane, SourceAnchor[]>;
  /** documented member tool name → the source anchors that documented it. */
  toolsToSources: Map<string, SourceAnchor[]>;
  /** WP-2A: how this toolset entered the DOCUMENTED set. `code-name` = a resident
   *  markdown tool mention resolved uniquely (observed-safe). `toolset-usage` = a
   *  resolved `mcp:` node named the toolset directly. A toolset documented ONLY via a
   *  heading (never implemented as a live path here) would be `heading` (inferred). */
  resolvedVia: Set<'toolset-usage' | 'code-name' | 'heading'>;
  /** WP-2A: the code-form tool name(s) that resolved to this toolset (provenance). */
  mentionedToolNames: Set<string>;
}

/** WP-2A: a resident markdown tool mention that did NOT resolve to a single registered
 *  toolset. Surfaced (never subtracted) as a `documented-unresolved-toolset` finding. */
interface UnresolvedRef {
  toolName: string;
  lane: PersonaLane;
  source: SourceAnchor;
  /** >1 entry ⇒ ambiguous; 0 entries ⇒ unresolved (no registered toolset). */
  candidateToolsets: string[];
}

/** WP-2A: a reverse index tool-name → registered toolset key(s), built from the drift
 *  deps' live defs. Explicit first-wins alias handling is not needed for the value
 *  (a name in several toolsets is deliberately kept ambiguous), but the toolset ORDER is
 *  the registered-set order so the ambiguity report is deterministic. */
export function buildReverseToolIndex(deps: ConfigDriftDeps): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const toolset of deps.registeredToolsets()) {
    for (const tool of deps.registeredToolNamesFor(toolset) ?? []) {
      const list = index.get(tool);
      if (list) { if (!list.includes(toolset)) list.push(toolset); }
      else index.set(tool, [toolset]);
    }
  }
  return index;
}

function addSource(map: Map<string, SourceAnchor[]>, key: string, src: SourceAnchor): void {
  const list = map.get(key);
  if (list && !list.some((s) => s.absPath === src.absPath && s.line === src.line)) list.push(src);
  else if (!list) map.set(key, [src]);
}

/**
 * Re-associate the compiler's flat action stream into documented toolset grants.
 * A resolved `mcp:` node compiles into ONE `toolset-usage{toolset}` plus one
 * `tool-invocation{toolName}` per member, all sharing a `source` anchor — so we
 * group by anchor, take the toolset from the toolset-usage, and its member tools
 * from the sibling tool-invocations. Coarse `toolset-usage{server}` grants (no
 * `toolset` key — the compiler's honest fallback when no mcp inventory resolver is
 * wired) are unresolvable against grants and are skipped.
 */
function collectDocumentedGrants(
  actions: PredictedAction[],
  rev: Map<string, string[]>,
): { grants: Map<string, DocumentedGrant>; unresolved: UnresolvedRef[] } {
  // Index actions by source anchor so siblings from one node stay together.
  const byAnchor = new Map<string, PredictedAction[]>();
  for (const a of actions) {
    const key = anchorKey(a.source);
    const list = byAnchor.get(key);
    if (list) list.push(a);
    else byAnchor.set(key, [a]);
  }

  const grants = new Map<string, DocumentedGrant>();
  const getGrant = (toolset: string): DocumentedGrant => {
    let g = grants.get(toolset);
    if (!g) {
      g = {
        toolset, lanesToSources: new Map(), toolsToSources: new Map(),
        resolvedVia: new Set(['toolset-usage']), mentionedToolNames: new Set(),
      };
      grants.set(toolset, g);
    }
    return g;
  };

  // Pass 1 — legacy anchor-grouped `mcp:` documentation: one toolset-usage plus its
  // sibling tool-invocations, keyed by shared source anchor.
  for (const group of byAnchor.values()) {
    const usage = group.find((a) => a.kind === 'toolset-usage' && !!a.params.toolset);
    if (!usage) continue; // no resolvable toolset at this anchor (coarse server / non-mcp)
    // WP-2A: a resident-markdown section identity is REQUIRED for a toolset-usage to
    // count as DOCUMENTED. This excludes knowledge-extractor's synthetic MCP inventory
    // nodes (generated FROM current grants, source = toolset script line 1,
    // sourceSectionKey:'') which otherwise masquerade as documentation and empty out
    // the DOCUMENTED set (the WP-2A root cause).
    if (!usage.sourceSectionKey) continue;
    const toolset = usage.params.toolset;
    const grant = getGrant(toolset);
    const lanes = usage.lanes.filter((l): l is PersonaLane => GRANT_LANE_SET.has(l));

    for (const lane of lanes) addSource(grant.lanesToSources, lane, usage.source);
    for (const a of group) {
      // A `fromProse` mention is a documented reference, not a grant member; it is
      // resolved in pass 2 via the reverse index, never folded in as a member tool here.
      if (a.kind === 'tool-invocation' && a.params.toolName && a.params.fromProse !== '1') {
        addSource(grant.toolsToSources, a.params.toolName, a.source);
      }
    }
  }

  // Pass 2 — resolve resident-markdown prose tool mentions (`tool-invocation` with
  // `fromProse:'1'`, emitted by the compiler when a `toolNameResolver` seam is wired)
  // to their registered toolset via the reverse index. A unique resolution folds into
  // DOCUMENTED (resolvedVia 'code-name'); ambiguous (>1) or unresolved (0) becomes an
  // `UnresolvedRef` that the engine surfaces as a typed suppression diagnostic — NEVER
  // a subtract.
  const unresolved: UnresolvedRef[] = [];
  for (const a of actions) {
    if (a.params.fromProse !== '1') continue;
    if (!a.sourceSectionKey) continue; // must be resident markdown, never synthetic
    const toolName = a.params.toolName;
    if (!toolName) continue;
    const sets = rev.get(toolName) ?? [];
    const lanes = a.lanes.filter((l): l is PersonaLane => GRANT_LANE_SET.has(l));
    if (sets.length === 1) {
      const grant = getGrant(sets[0]);
      for (const lane of lanes) addSource(grant.lanesToSources, lane, a.source);
      grant.mentionedToolNames.add(toolName);
      grant.resolvedVia.add('code-name');
    } else {
      // ambiguous (name in >1 toolset) or unresolved (name in no registered toolset)
      for (const lane of lanes) {
        unresolved.push({ toolName, lane, source: a.source, candidateToolsets: sets });
      }
    }
  }

  return { grants, unresolved };
}

function sortedAnchors(list: SourceAnchor[]): SourceAnchor[] {
  return [...list].sort((a, b) => (a.absPath === b.absPath ? a.line - b.line : a.absPath < b.absPath ? -1 : 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-join DOCUMENTED × GRANTED × REGISTERED per lane and emit drift findings
 * (design §5.2 A5). Pure, deterministic, log-free. Every finding is `observed-safe`.
 *
 * Findings are ordered: kind (not-granted → decommissioned → undocumented), then
 * lane (supervisor → worker → researcher), then toolset, then toolName.
 */
export function detectConfigDrift(actions: PredictedAction[], deps: ConfigDriftDeps): DriftFinding[] {
  const rev = buildReverseToolIndex(deps);
  const { grants: documented, unresolved } = collectDocumentedGrants(actions, rev);
  const registeredSet = new Set(deps.registeredToolsets());
  const grantByLane = new Map<PersonaLane, Set<string>>();
  for (const lane of GRANT_LANES) grantByLane.set(lane, grantSet(deps.grantedToolsetsFor(lane)));

  const findings: DriftFinding[] = [];

  // ── DOCUMENTED-side drift: not-granted + decommissioned ────────────────────
  for (const grant of documented.values()) {
    const { toolset } = grant;
    const isRegistered = registeredSet.has(toolset);
    const liveMembers = isRegistered ? new Set(deps.registeredToolNamesFor(toolset) ?? []) : null;
    // WP-2A: a toolset that entered DOCUMENTED via a resolved prose tool mention carries
    // its code-name provenance onto the grant-mismatch findings, so the engine can
    // present the observed-safe basis. Legacy `mcp:` toolset-usage documentation leaves
    // these undefined (it is already toolset-granular).
    const viaCodeName = grant.resolvedVia.has('code-name');
    const codeNameProvenance = viaCodeName && grant.mentionedToolNames.size > 0
      ? { resolutionConfidence: 'code-name' as const, mentionedToolName: [...grant.mentionedToolNames].sort().join(', ') }
      : {};

    for (const [lane, sources] of grant.lanesToSources) {
      const granted = grantByLane.get(lane)!.has(toolset);

      // documented-but-not-granted — the lane reaches for a toolset it can't invoke.
      if (!granted) {
        findings.push({
          kind: 'documented-but-not-granted',
          lane,
          toolset,
          evidenceTier: DRIFT_TIER,
          detail: `${lane} persona documents toolset '${toolset}' but the lane is not granted it`,
          sources: sortedAnchors(sources),
          ...codeNameProvenance,
        });
      }

      // documented-but-decommissioned (whole toolset) — the toolset def is gone.
      // Grant-independent: registration, not the grant, is what proves it's dead.
      if (!isRegistered) {
        findings.push({
          kind: 'documented-but-decommissioned',
          lane,
          toolset,
          evidenceTier: DRIFT_TIER,
          detail: `${lane} persona documents toolset '${toolset}' but it is not registered in the live toolset defs (decommissioned)`,
          sources: sortedAnchors(sources),
          ...codeNameProvenance,
        });
      }
    }

    // documented-but-decommissioned (member tool) — the toolset lives but a
    // documented member does not. Emitted per documenting lane for panel scoping.
    if (liveMembers) {
      const deadMembers = [...grant.toolsToSources.keys()].filter((t) => !liveMembers.has(t)).sort();
      for (const toolName of deadMembers) {
        const memberSources = sortedAnchors(grant.toolsToSources.get(toolName)!);
        for (const lane of [...grant.lanesToSources.keys()].sort()) {
          findings.push({
            kind: 'documented-but-decommissioned',
            lane,
            toolset,
            toolName,
            evidenceTier: DRIFT_TIER,
            detail: `${lane} persona documents tool '${toolName}' (toolset '${toolset}') but it is decommissioned from the live defs`,
            sources: memberSources,
          });
        }
      }
    }
  }

  // ── GRANTED-side drift: granted-but-undocumented ───────────────────────────
  for (const lane of GRANT_LANES) {
    const granted = grantByLane.get(lane)!;
    for (const toolset of granted) {
      const documentedInLane = documented.get(toolset)?.lanesToSources.has(lane) ?? false;
      if (!documentedInLane) {
        findings.push({
          kind: 'granted-but-undocumented',
          lane,
          toolset,
          evidenceTier: DRIFT_TIER,
          detail: `${lane} lane is granted toolset '${toolset}' but no persona line documents using it`,
          sources: [],
        });
      }
    }
  }

  // ── DOCUMENTED-unresolved drift: a resident markdown tool mention that did not
  //    resolve to a single registered toolset (ambiguous → many, or unresolved → none).
  //    NEVER a subtract: the engine converts each into a typed grant-mismatch-evaluation
  //    diagnostic (ambiguous-toolset / unresolved-documentation) so the suppression is
  //    auditable rather than silent.
  for (const ref of unresolved) {
    const ambiguous = ref.candidateToolsets.length > 1;
    findings.push({
      kind: 'documented-unresolved-toolset',
      lane: ref.lane,
      toolset: ref.toolName,
      mentionedToolName: ref.toolName,
      candidateToolsets: ref.candidateToolsets,
      resolutionConfidence: 'code-name',
      evidenceTier: DRIFT_TIER,
      detail: ambiguous
        ? `${ref.lane} documents tool '${ref.toolName}' but it maps to ${ref.candidateToolsets.length} toolsets (${ref.candidateToolsets.join(', ')}) — ambiguous, suppressed`
        : `${ref.lane} documents tool '${ref.toolName}' but it resolves to no registered toolset`,
      sources: [ref.source],
    });
  }

  return sortFindings(findings);
}

function laneRank(lane: PersonaLane): number {
  return GRANT_LANES.indexOf(lane);
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortFindings(findings: DriftFinding[]): DriftFinding[] {
  return findings.sort((a, b) =>
    (DRIFT_ORDER[a.kind] - DRIFT_ORDER[b.kind]) ||
    (laneRank(a.lane) - laneRank(b.lane)) ||
    cmpStr(a.toolset, b.toolset) ||
    cmpStr(a.toolName ?? '', b.toolName ?? ''),
  );
}
