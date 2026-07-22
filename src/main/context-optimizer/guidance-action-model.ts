// guidance-action-model.ts — the WP5 "compiler" (design §5.1).
//
// Turns P3/WP4 `KnowledgeNode[]` (typed markdown-structure facts with verbatim
// `{absPath,line}` anchors) into `PredictedAction[]`: the mechanically-observable
// predicate each guidance line PREDICTS a supervised agent will do, so the
// occurrence classifier (§5.2) can later ask "did the rent get paid?".
//
// HARD boundaries this module encodes:
//  • It CONSUMES KnowledgeNodes — it never re-parses persona markdown (that was
//    WP4's job). Sectioning here is only to price the owning unit + name its epoch.
//  • `unmatchable` is a FIRST-CLASS honesty boundary (§5.1), never a fallback: a
//    prose line we cannot mechanically observe is emitted as `unmatchable` so it is
//    surfaced in the "Not analyzable" UI and is NEVER eligible to be called dead.
//  • Every occurrence-derived action carries its OPEN EPOCH (`sourceEpochId`) +
//    section identity (`sourceSectionKey`) — WP5 compiles from the resident
//    inventory, so each prediction is dated to the epoch it was compiled from
//    (epochs addendum §2). `requiresDerivationGate` marks the ones the WP5 parity
//    gate governs (everything except `unmatchable`, which is unobservable).
//  • `lanes[]` is REUSED from module-1's `collectMarkdownTargets` lane-union (A11) —
//    we never re-derive lane inheritance here.
//
// Pure over (nodes, injected deps). Deterministic: stable ids (sha256 of anchor +
// kind + sorted params), stable ordering (node order, then action order). No clocks.

import type { AgentRoleLane, KnowledgeNode } from '../../shared/types';
import {
  deriveAnchors,
  parseMarkdownSections,
  sha256Hex,
  type ResidentTarget,
  type SectionCandidate,
} from './resident-inventory';
import {
  canonicalizeAccessPath,
  inferAccessModes,
  type FileAccessBase,
  type FileAccessMode,
} from './file-access-path';

// ─────────────────────────────────────────────────────────────────────────────
// Types (design §5.1)
// ─────────────────────────────────────────────────────────────────────────────

export type PredicateKind =
  | 'tool-invocation' | 'skill-invocation' | 'toolset-usage'
  | 'command-family'  | 'path-touch'       | 'search-pattern'
  | 'workflow-sequence' | 'decision-branch' | 'unmatchable';

export type Derivability = 'exact' | 'heuristic' | 'unmatchable';

/** WP-1B (Priority 0) — cwd-RESOLVED file identity carried ALONGSIDE a `path-touch`
 *  action's legacy `params.pathGlob` (which is left untouched so file-coverage /
 *  parity-gate keep working, and so the action `id` hash is stable). The occurrence
 *  classifier reads this to build the richer `file-access` behavior predicate.
 *  `canonicalAbs`/`workspaceRelative` are undefined when the reference could not be
 *  resolved (relative path with no representative cwd, or a glob token) — the
 *  classifier then rules the action unobservable rather than dead. */
export interface FileAccessInfo {
  raw: string;
  canonicalAbs?: string;
  workspaceRelative?: string;
  base: FileAccessBase;
  /** Required access mode(s); empty ⇒ ambiguous instruction (any touch, candidate-only). */
  modes: FileAccessMode[];
  /** Session-start windows are not implemented yet (brief §5) → always `unverified`. */
  timing: 'unverified';
}

export interface PredictedAction {
  id: string;                          // stable hash(sourceAnchor + kind + params)
  source: { absPath: string; line: number };
  sourceKind: KnowledgeNode['type'];
  lanes: AgentRoleLane[];              // lanes that inherit source.absPath (module-1 union)
  kind: PredicateKind;
  params: Record<string, string>;      // toolName|skillName|toolset|server|commandFamily|pathGlob|queryHash|sequence|branch
  derivability: Derivability;
  residentTokens: number;              // cost of the smallest enclosing section (the unit we would delete)
  sourceSectionKey: string;            // epoch identity of the owning section ('' when unresolved)
  sourceEpochId: string;               // the open epoch this action was compiled from ('' when unresolved)
  requiresDerivationGate: boolean;     // WP5 parity gate governs it (true ⇔ occurrence-derived, i.e. not unmatchable)
  fileAccess?: FileAccessInfo;         // WP-1B: resolved identity for path-touch actions (absent otherwise)
  /** WP2 (G2): the owning guidance source's provider audience, carried verbatim
   *  from the KnowledgeNode. Present ⇒ the action is AUDIENCE-SCOPED and its
   *  liveness verdict is subject to the capture-coverage never-gate (only a
   *  provably `complete` audience cohort may support `never`/dead). Absent ⇒
   *  legacy Claude walk-up guidance — semantics unchanged. */
  audienceProviders?: string[] | 'unknown';
}

export interface CompileDeps {
  /** Lane-union resident targets from module-1 `collectMarkdownTargets` (A11).
   *  Indexed here by resolved source path so a node's `source.absPath` maps to its
   *  owning target's text (for sectioning + token cost), lane-union, and the epoch
   *  identity prefix (`targetType:targetKey`). */
  residentTargets: ResidentTarget[];
  /** Sync token estimator (P1 `token-estimator`). Given the enclosing section text
   *  → token count. Injected so the compiler stays pure + testable. */
  estimateTokens: (text: string) => number;
  /** Resolve the OPEN epoch id for a `section_key` (config_epochs WHERE
   *  last_seen_ms IS NULL). Absent / null ⇒ the action carries an empty
   *  `sourceEpochId` (honest: the backfill/reconcile has not dated this section
   *  yet), never a fabricated id. */
  openEpochIdFor?: (sectionKey: string) => string | null;
  /** Resolve an MCP server display name → its toolset key + member tool names
   *  (`mcpInventory.forLane`, §4.3). Absent ⇒ a `mcp:` node degrades to a single
   *  server-granularity `toolset-usage` (honest, coarser) instead of an enumerated
   *  toolset + per-tool fan-out. */
  mcpServerResolver?: (displayName: string) => { toolset: string; tools: string[] } | null;
  /** WP-1B: representative agent cwd for the lanes that inherit a guidance path.
   *  Used to resolve `./…` / bare-relative file references to a canonical absolute
   *  (the AGENT working directory — NOT the CLAUDE.md source directory). Absent /
   *  null ⇒ relative references stay unresolved (candidate-only → unobservable),
   *  never suffix-matched. Absolute references still resolve without it. */
  representativeAgentCwd?: (lanes: AgentRoleLane[]) => string | null;
  /** WP-1B: workspace root for the same lanes, so an explicit workspace-relative
   *  reference also gets a root-anchored identity. Absent ⇒ workspace-relative
   *  matching is simply not attempted (canonical-absolute matching still applies). */
  workspaceRootForLanes?: (lanes: AgentRoleLane[]) => string | null;
  /** WP-2A (Priority 0): resolve a code-form tool name mentioned in RESIDENT markdown
   *  prose (e.g. `create_team`) → the toolset key(s) that register it. This is what
   *  lets real documentation become the DOCUMENTED input config-drift needs (the prose
   *  compiler otherwise treats backticks as commands/paths only). Absent ⇒ prose tool
   *  mentions are NOT emitted (the pre-WP-2A behaviour), so every existing compiler test
   *  is unaffected. Returns `[]` for a token that is not a known tool. The compiler uses
   *  it only as a GATE (is this a real tool name?) — config-drift owns the authoritative
   *  ambiguity resolution, so a returned length ≥ 1 is enough to surface the mention. */
  toolNameResolver?: (toolName: string) => readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifiers (deterministic)
// ─────────────────────────────────────────────────────────────────────────────

// Backtick span with a slash + extension → a file path token (mirrors WP4
// knowledge-extractor BACKTICK_PATH so the two agree on what "a path" is).
const BACKTICK_PATH = /`([^`\n]*\/[^`\n]*\.[A-Za-z0-9]{1,6})`/g;
// Any backtick span (candidate command / path).
const BACKTICK_SPAN = /`([^`\n]+)`/g;
// `@path` inline import token (slash-free allowed; must carry an extension).
const IMPORT_TOKEN = /(?:^|\s)@([^\s`]+\.[A-Za-z0-9]{1,6})/g;
// Leading executable of a shell command we treat as a command family.
const COMMAND_HEAD = /^(npm|pnpm|yarn|npx|git|node|python3?|deno|bun|docker|cargo|go|make|bash|sh|pwsh|powershell|rg|grep|tsc|jest|vitest|eslint|prettier|tsx)\b/i;
// Search-intent verbs (no command) → search-pattern.
const SEARCH_INTENT = /\b(search|grep|rg|ripgrep|find|look\s*up|lookup)\b/i;
// "when X …" / "if X …" imperative → decision-branch.
const DECISION_BRANCH = /^\s*(?:when|if)\b/i;

/** P0-parity command family: pm-script → `npm-run:<name>` (matches
 *  command-path-extractor.ts:267); otherwise the leading executable token,
 *  lowercased. The formal WP5 parity gate (compiler-parity-gate.ts) verifies this
 *  against P0's stored `command_family`. */
function commandFamilyOf(cmd: string): string | null {
  const toks = cmd.trim().split(/\s+/);
  const head = (toks[0] ?? '').toLowerCase();
  if (!head) return null;
  if ((head === 'npm' || head === 'pnpm' || head === 'yarn') && toks[1] === 'run') {
    return `npm-run:${toks[2] ?? ''}`;
  }
  if (!COMMAND_HEAD.test(cmd.trim())) return null;
  return head;
}

/** Normalize a path token for a `path-touch` glob: strip a leading `@`, backslashes
 *  → forward slashes. Kept minimal — the classifier's Read/Edit/Glob matcher
 *  glob-matches `arg_path` against this (§5.2). */
function pathGlobOf(token: string): string {
  return token.replace(/^@/, '').replace(/\\/g, '/').trim();
}

/** Stable 16-hex query hash for a search-pattern, mirroring P0's
 *  `search_signature_hash` normalization intent (lowercase, collapse whitespace). */
function queryHashOf(text: string): string {
  const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return sha256Hex(`search:${norm}`).slice(0, 16);
}

interface RawAction {
  kind: PredicateKind;
  params: Record<string, string>;
  derivability: Derivability;
  // WP-1B: path actions carry the raw token + the prose to infer access mode from,
  // so the assembly step (which knows lanes + deps) can resolve a canonical identity.
  pathToken?: string;
  modeText?: string;
}

/** Extract every backtick span from `text`, split into commands vs path tokens. */
function scanBackticks(text: string): { commands: string[]; paths: string[] } {
  const commands: string[] = [];
  const paths = new Set<string>();
  BACKTICK_PATH.lastIndex = 0;
  let pm: RegExpExecArray | null;
  while ((pm = BACKTICK_PATH.exec(text)) !== null) paths.add(pm[1]);
  BACKTICK_SPAN.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = BACKTICK_SPAN.exec(text)) !== null) {
    const span = sm[1].trim();
    if (paths.has(span)) continue;             // already a path token
    if (COMMAND_HEAD.test(span)) commands.push(span);
  }
  IMPORT_TOKEN.lastIndex = 0;
  let im: RegExpExecArray | null;
  while ((im = IMPORT_TOKEN.exec(text)) !== null) paths.add(`@${im[1]}`);
  return { commands, paths: [...paths] };
}

// WP-2A: a bare code-form identifier — snake_case with ≥1 underscore (the MCP tool
// naming convention: `create_team`, `read_agent_chat`, `browser_open_url`). Distinct
// from a command (has a space/flag), a path (slash/dot), or prose (spaces). A backtick
// span matching this is a candidate tool mention, resolved against the live defs.
const TOOL_NAME_TOKEN = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;

/** WP-2A: backtick code-form tool-name mentions in resident prose that resolve (via the
 *  injected reverse index) to ≥1 registered toolset. Empty when no resolver is wired
 *  (pre-WP-2A behaviour) or nothing resolves. */
function scanToolNames(text: string, resolver: CompileDeps['toolNameResolver']): string[] {
  if (!resolver) return [];
  const out = new Set<string>();
  BACKTICK_SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BACKTICK_SPAN.exec(text)) !== null) {
    const span = m[1].trim();
    if (!TOOL_NAME_TOKEN.test(span)) continue;
    if (resolver(span).length >= 1) out.add(span);
  }
  return [...out];
}

/** Prose/imperative node (workflow|capability|constraint|memory) → observable
 *  predicates, or the honesty boundary `unmatchable` when nothing is mechanical. */
function actionsForProse(node: KnowledgeNode, deps: CompileDeps): RawAction[] {
  const text = `${node.label}${node.detail ? `\n${node.detail}` : ''}`;
  const out: RawAction[] = [];
  const seen = new Set<string>();
  const add = (a: RawAction): void => {
    const k = `${a.kind}|${stableParams(a.params)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(a);
  };

  const { commands, paths } = scanBackticks(text);

  // WP-2A: code-form tool-name mentions → tool-invocation (documented mention). Marked
  // `fromProse` so config-drift knows to resolve it via the reverse index (no sibling
  // toolset-usage anchors it). `heuristic`: a documented mention, not a guaranteed call.
  for (const toolName of scanToolNames(text, deps.toolNameResolver)) {
    add({ kind: 'tool-invocation', params: { toolName, fromProse: '1' }, derivability: 'heuristic' });
  }

  // Fenced/backticked commands → one command-family each (exact).
  const families: string[] = [];
  for (const cmd of commands) {
    const fam = commandFamilyOf(cmd);
    if (!fam) continue;
    families.push(fam);
    add({ kind: 'command-family', params: { commandFamily: fam }, derivability: 'exact' });
  }
  // Ordered workflow with ≥2 command steps → one workflow-sequence (heuristic).
  if (node.type === 'workflow' && families.length >= 2) {
    add({ kind: 'workflow-sequence', params: { sequence: families.join('>') }, derivability: 'heuristic' });
  }

  // File-reference / @import path tokens → path-touch (exact). WP-1B: carry the token
  // + the surrounding prose so the assembler resolves a canonical identity + access mode.
  for (const p of paths) {
    const token = pathGlobOf(p);
    add({ kind: 'path-touch', params: { pathGlob: token }, derivability: 'exact', pathToken: token, modeText: text });
  }

  if (out.length === 0) {
    // No command, no path: fall to the softer heuristics, else the honesty boundary.
    if (SEARCH_INTENT.test(node.label)) {
      add({ kind: 'search-pattern', params: { queryHash: queryHashOf(node.label) }, derivability: 'heuristic' });
    } else if (DECISION_BRANCH.test(node.label)) {
      add({ kind: 'decision-branch', params: { branch: clip(node.label, 120) }, derivability: 'heuristic' });
    } else {
      // pure prose ("be concise", "trust your supervisor", "attribution honesty")
      add({ kind: 'unmatchable', params: {}, derivability: 'unmatchable' });
    }
  }
  return out;
}

/** `tool` node → skill/mcp/plain-tool predicates. */
function actionsForTool(node: KnowledgeNode, deps: CompileDeps): RawAction[] {
  const skill = /^skill:\s*(.+)$/i.exec(node.label);
  if (skill) return [{ kind: 'skill-invocation', params: { skillName: skill[1].trim() }, derivability: 'exact' }];

  const mcp = /^mcp:\s*(.+)$/i.exec(node.label);
  if (mcp) {
    const display = mcp[1].trim();
    const resolved = deps.mcpServerResolver?.(display) ?? null;
    if (resolved) {
      const out: RawAction[] = [
        { kind: 'toolset-usage', params: { toolset: resolved.toolset }, derivability: 'exact' },
      ];
      for (const t of resolved.tools) {
        out.push({ kind: 'tool-invocation', params: { toolName: t }, derivability: 'exact' });
      }
      return out;
    }
    // No inventory resolver ⇒ honest coarse grant, keyed by server display name.
    return [{ kind: 'toolset-usage', params: { server: display }, derivability: 'exact' }];
  }

  return [{ kind: 'tool-invocation', params: { toolName: node.label.trim() }, derivability: 'exact' }];
}

// ─────────────────────────────────────────────────────────────────────────────
// Section / epoch resolution
// ─────────────────────────────────────────────────────────────────────────────

interface TargetIndexEntry { target: ResidentTarget; sections: SectionCandidate[] }

function buildTargetIndex(targets: ResidentTarget[]): Map<string, TargetIndexEntry> {
  const idx = new Map<string, TargetIndexEntry>();
  for (const target of targets) {
    if (target.targetType !== 'markdown_section') continue;
    const sections = deriveAnchors(parseMarkdownSections(target.text));
    idx.set(normKey(target.sourcePath), { target, sections });
  }
  return idx;
}

/** Smallest enclosing section for a 1-based line (innermost / narrowest span wins). */
function enclosingSection(sections: SectionCandidate[], line: number): SectionCandidate | null {
  let best: SectionCandidate | null = null;
  for (const s of sections) {
    if (line < s.lineStart || line > s.lineEnd) continue;
    if (!best || (s.lineEnd - s.lineStart) < (best.lineEnd - best.lineStart)) best = s;
  }
  return best;
}

function normKey(p: string): string { return p.replace(/\\/g, '/'); }

/** section_key format mirrors resident-inventory `sectionKeyFor`
 *  (`${targetType}:${targetKey}:${rawAnchor}`) so the compiler's key JOINs the
 *  ledger the reconciler wrote. */
function sectionKeyFor(target: ResidentTarget, section: SectionCandidate): string {
  return `${target.targetType}:${target.targetKey}:${section.rawAnchor}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Compile
// ─────────────────────────────────────────────────────────────────────────────

function stableParams(params: Record<string, string>): string {
  return Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Build the resolved `FileAccessInfo` for a path token (WP-1B). `canonicalAbs` is
 *  present only when the token resolves to a genuine absolute — a relative reference
 *  with no `agentCwd`, or a glob token, stays unresolved (candidate-only). Access
 *  mode comes from the surrounding prose via the explicit verb lexicon. */
function buildFileAccess(token: string, modeText: string, agentCwd: string | null, workspaceRoot: string | null): FileAccessInfo {
  const canon = canonicalizeAccessPath(token, agentCwd, workspaceRoot);
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(token) || token.replace(/\\/g, '/').startsWith('/');
  const base: FileAccessBase = canon.canonicalAbs
    ? (isAbsolute ? 'source-dir' : 'agent-cwd')
    : 'unknown';
  const info: FileAccessInfo = { raw: canon.raw, base, modes: inferAccessModes(modeText), timing: 'unverified' };
  if (canon.canonicalAbs) info.canonicalAbs = canon.canonicalAbs;
  if (canon.workspaceRelative !== undefined) info.workspaceRelative = canon.workspaceRelative;
  return info;
}

/** Compile one agent's KnowledgeNodes into PredictedActions (design §5.1). Pure
 *  over (nodes, deps). Order is stable: node order, then per-node action order. */
export function compileGuidanceActions(nodes: KnowledgeNode[], deps: CompileDeps): PredictedAction[] {
  const index = buildTargetIndex(deps.residentTargets);
  const out: PredictedAction[] = [];

  for (const node of nodes) {
    const fileRefToken = pathGlobOf(node.label);
    const raws: RawAction[] = node.type === 'tool'
      ? actionsForTool(node, deps)
      : node.type === 'file-reference'
        ? [{
            kind: 'path-touch', params: { pathGlob: fileRefToken }, derivability: 'exact',
            pathToken: fileRefToken, modeText: `${node.label}${node.detail ? `\n${node.detail}` : ''}`,
          }]
        : actionsForProse(node, deps);

    // Resolve the owning section once per node → residentTokens + epoch identity.
    const entry = node.source.absPath ? index.get(normKey(node.source.absPath)) : undefined;
    const section = entry ? enclosingSection(entry.sections, node.source.lineStart) : null;
    let residentTokens = 0;
    let sourceSectionKey = '';
    let sourceEpochId = '';
    if (entry && section) {
      residentTokens = deps.estimateTokens(`${section.rawHeadingLine}\n${section.body}`);
      sourceSectionKey = sectionKeyFor(entry.target, section);
      sourceEpochId = deps.openEpochIdFor?.(sourceSectionKey) ?? '';
    }
    const lanes = entry ? entry.target.lanes : [];
    // WP-1B: resolve the representative agent cwd + workspace root ONCE per node —
    // paths resolve against the AGENT working directory, not the CLAUDE.md dir.
    const agentCwd = deps.representativeAgentCwd?.(lanes) ?? null;
    const workspaceRoot = deps.workspaceRootForLanes?.(lanes) ?? null;

    for (const raw of raws) {
      const anchor = `${node.source.absPath}:${node.source.lineStart}`;
      const id = sha256Hex(`${anchor}|${raw.kind}|${stableParams(raw.params)}`).slice(0, 16);
      const action: PredictedAction = {
        id,
        source: { absPath: node.source.absPath, line: node.source.lineStart },
        sourceKind: node.type,
        lanes,
        kind: raw.kind,
        params: raw.params,
        derivability: raw.derivability,
        residentTokens,
        sourceSectionKey,
        sourceEpochId,
        requiresDerivationGate: raw.kind !== 'unmatchable',
      };
      // WP2 (G2): AGENTS.md (and any audience-tagged) nodes propagate their
      // provider audience so the occurrence classifier can gate `never` on
      // capture coverage of that audience.
      if (node.audienceProviders !== undefined) action.audienceProviders = node.audienceProviders;
      if (raw.kind === 'path-touch' && raw.pathToken) {
        action.fileAccess = buildFileAccess(raw.pathToken, raw.modeText ?? '', agentCwd, workspaceRoot);
      }
      out.push(action);
    }
  }

  return out;
}
