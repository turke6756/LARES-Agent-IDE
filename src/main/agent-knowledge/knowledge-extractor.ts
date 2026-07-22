// "What This Agent Knows" — deterministic knowledge extractor (base plan P3.1 /
// master WP4).
//
// Turns an agent's ALREADY-RESOLVED config surfaces into typed `KnowledgeNode`s
// using markdown STRUCTURE ONLY — no LLM, no summarization, no network. Every
// node carries a click-through `source` pointer (absPath + 1-based line) so the
// panel can open the exact place a fact came from.
//
// Inheritance is taken VERBATIM from the P1 walk-up (A11): we iterate the agent's
// `inheritanceChain` frames and `mcpServers` (which the analyzer already filled
// from `mcpInventory.forLane`) — we NEVER hand-list per-lane config paths. The
// shared `@import` resolver (§3.2) supplies inline `@path` file-reference tokens.
//
// Pure: all file IO is injected via `deps.readFile`. Given the same agent model +
// file contents, the output is byte-stable (deterministic ordering, no clocks).

import type {
  AgentContextOverhead,
  InheritanceScope,
  KnowledgeNode,
  KnowledgeNodeType,
  KnowledgeSourceFile,
  KnowledgeSourceRole,
  OverheadSource,
  OverheadSourceKind,
} from '../../shared/types';
import { extractClaudeImports } from '../shared/claude-import-resolver';

export interface KnowledgeExtractDeps {
  /** Read a file's text, or null when missing/unreadable. Injected so the
   *  extractor stays pure + testable (fixtures in tests, fs/WSL in production). */
  readFile: (absPath: string) => string | null;
}

export interface KnowledgeExtractOpts {
  /** Repo-root directory. When a frame's `dir` equals this, an `inherited-claude`
   *  source is the WORKSPACE CLAUDE.md (`workspace-claude`) rather than an ancestor
   *  one — the precise agent-vs-workspace attribution the WP2 panel needs. */
  workspaceRoot?: string;
}

/** Precise, human-facing provenance role for a walk-up source kind (WP2). Distinct
 *  from `InheritanceScope`: it answers "WHICH CLAUDE.md / surface" a fact came from.
 *  `frameDir`/`workspaceRoot` disambiguate the workspace-root CLAUDE.md from ancestors. */
function roleForSource(
  kind: OverheadSourceKind,
  frameDir: string,
  workspaceRoot?: string,
): KnowledgeSourceRole {
  switch (kind) {
    case 'agent-claude':
      return 'agent-claude';
    case 'inherited-claude':
    case 'claude-local':
      return workspaceRoot && frameDir === workspaceRoot ? 'workspace-claude' : 'ancestor-claude';
    case 'user-claude':
      return 'user-claude';
    case 'managed-policy':
      return 'managed';
    case 'skill':
    case 'skill-header':
    case 'skill-body':
      return 'skill';
    case 'import':
      return 'import';
    case 'memory':
    case 'memory-index':
    case 'memory-body':
    case 'behavioral':
      return 'memory';
    case 'mcp-tool-schema':
      return 'mcp';
    case 'agents-md':
      // WP2 (G2): an applicable AGENTS.md on the root→cwd directory chain.
      return 'agents-md';
    default:
      return 'other';
  }
}

/** Markdown source kinds the extractor parses for structural nodes. Non-markdown
 *  kinds (settings.json hooks, synthetic MCP/baseline rows) are handled
 *  separately or skipped. */
const MARKDOWN_KINDS = new Set<OverheadSourceKind>([
  'agent-claude', 'inherited-claude', 'claude-local', 'user-claude',
  'managed-policy', 'rules', 'memory', 'behavioral',
  'skill', 'skill-header', 'skill-body', 'import',
  // WP2 (G2): APPLICABLE AGENTS.md files reach the chain only when the agent's
  // provider is in the file's audience (analyzer-side filter) — so admitting the
  // kind here never extracts guidance an agent doesn't load. Heading-based
  // sourceSectionKey derivation downstream is file-agnostic.
  'agents-md',
]);

const SKILL_KINDS = new Set<OverheadSourceKind>(['skill', 'skill-header', 'skill-body']);

// Bounds so a pathological file can't blow up a node label/detail.
const LABEL_MAX = 140;
const DETAIL_MAX = 240;

// ── line classifiers (deterministic) ──────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*[-*+]\s+(.+?)\s*$/;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.+?)\s*$/;

// Negative / prohibitive imperative → constraint.
const NEG_IMPERATIVE = /^(never|don'?t|do\s+not|avoid|must\s+not|no\s|should\s+not|refrain|cannot|can'?t|do\s+n['o]t)\b/i;
// Positive imperative verbs (base-form leading verb) → capability. Allowlist keeps
// the classifier deterministic and free of false positives on descriptive prose.
const POS_IMPERATIVE = /^(always|prefer|use|run|read|write|call|register|keep|treat|end|frame|ensure|check|stop|split|reuse|follow|surface|append|open|add|resolve|derive|apply|emit|classify|include|exclude|store|render|attach|update|verify|launch|route|pass|point|fold|report|trust|disambiguate|bump|rebuild|restart)\b/i;
// Workflow-flavored heading text.
const WORKFLOW_HEADING = /\bhow\s+to\b|\bworkflow\b|\bsteps?\b|\bprocedure\b|\bprocess\b/i;
// MEMORY reference token anywhere on a line.
const MEMORY_REF = /\bMEMORY\.md\b|(^|\/)memory\//i;
// Inline backticked path token: `dir/file.ext` (must contain a slash + extension).
const BACKTICK_PATH = /`([^`\n]*\/[^`\n]*\.[A-Za-z0-9]{1,6})`/g;

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** First sentence of `s`, verbatim (up to a terminal `.`/`!`/`?` + space/EOL). */
function firstSentence(s: string): string {
  const m = /^(.*?[.!?])(\s|$)/.exec(s.trim());
  return m ? m[1] : s.trim();
}

/** Skill directory name from a `.claude/skills/<name>/SKILL.md` path. */
function skillName(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/');
  const m = /\/skills\/([^/]+)\//.exec(norm);
  if (m) return m[1];
  const segs = norm.split('/').filter(Boolean);
  return segs[segs.length - 2] ?? segs[segs.length - 1] ?? absPath;
}

// ── markdown → nodes ──────────────────────────────────────────────────────────

/** Parse one markdown file into structural KnowledgeNodes. Deterministic:
 *  headings→capability/workflow, imperative bullets→capability/constraint,
 *  numbered items→workflow, MEMORY refs→memory, `@path`/backticked paths→
 *  file-reference. Fenced code blocks are skipped so examples don't leak nodes. */
function parseMarkdownNodes(
  content: string,
  absPath: string,
  scope: InheritanceScope,
  role: KnowledgeSourceRole,
  kind: OverheadSourceKind,
): KnowledgeNode[] {
  const nodes: KnowledgeNode[] = [];
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const seenFileRefs = new Set<string>();
  let inFence = false;

  // WP2: every node carries a source SPAN. Single-line nodes pass lineStart===lineEnd;
  // headings pass the computed section end so the WP4 highlight covers the whole section.
  const push = (
    type: KnowledgeNodeType, label: string, lineStart: number, lineEnd: number, detail?: string,
  ): void => {
    const l = clip(label, LABEL_MAX);
    if (!l) return;
    nodes.push({
      type,
      label: l,
      ...(detail && detail.trim() ? { detail: clip(detail, DETAIL_MAX) } : {}),
      source: { absPath, lineStart, lineEnd },
      sourceScope: scope,
      sourceRole: role,
      sourceKind: kind,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // Fenced code blocks: toggle and skip (deterministic — no nodes from examples).
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Headings → capability (or workflow when how-to/numbered).
    const h = HEADING_RE.exec(raw);
    if (h) {
      const text = h[2].trim();
      const level = h[1].length;
      // Look ahead for the section synopsis (first non-empty, non-heading line).
      let synopsis: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (HEADING_RE.test(lines[j])) break;
        if (/^\s*```/.test(lines[j])) break;
        synopsis = firstSentence(t.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''));
        break;
      }
      // Section span: this heading line → the line before the next same-or-higher
      // heading (or EOF). A next heading at 0-based index j is 1-based line j+1, so
      // the line before it is j (1-based). No next heading → the last line.
      let endLine = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        const hj = HEADING_RE.exec(lines[j]);
        if (hj && hj[1].length <= level) { endLine = j; break; }
      }
      const isWorkflow = WORKFLOW_HEADING.test(text) || /^\d/.test(text);
      push(isWorkflow ? 'workflow' : 'capability', text, lineNo, endLine, synopsis);
      continue;
    }

    // Numbered list item → workflow step.
    const num = NUMBERED_RE.exec(raw);
    if (num) {
      push('workflow', num[1], lineNo, lineNo);
      // fall through so a numbered item can still yield file-refs / memory below
    } else {
      // Bullet → capability / constraint when imperative.
      const b = BULLET_RE.exec(raw);
      if (b) {
        const text = b[1].trim();
        if (NEG_IMPERATIVE.test(text)) push('constraint', text, lineNo, lineNo);
        else if (POS_IMPERATIVE.test(text)) push('capability', text, lineNo, lineNo);
      }
    }

    // MEMORY references (any line).
    if (MEMORY_REF.test(trimmed)) {
      push('memory', trimmed, lineNo, lineNo);
    }

    // Inline backticked path tokens → file-reference (dedup within file).
    BACKTICK_PATH.lastIndex = 0;
    let pm: RegExpExecArray | null;
    while ((pm = BACKTICK_PATH.exec(raw)) !== null) {
      const p = pm[1];
      if (seenFileRefs.has(p)) continue;
      seenFileRefs.add(p);
      push('file-reference', p, lineNo, lineNo, trimmed);
    }
  }

  // `@path` imports (fence/inline-code aware via the shared resolver). Line number
  // resolved from the first raw occurrence; dedup against inline refs.
  for (const tok of extractClaudeImports(content)) {
    if (seenFileRefs.has(tok)) continue;
    seenFileRefs.add(tok);
    let line = 1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`@${tok}`)) { line = i + 1; break; }
    }
    nodes.push({
      type: 'file-reference',
      label: clip(`@${tok}`, LABEL_MAX),
      source: { absPath, lineStart: line, lineEnd: line },
      sourceScope: scope,
      sourceRole: role,
      sourceKind: kind,
    });
  }

  return nodes;
}

// ── top-level extraction ──────────────────────────────────────────────────────

/** Flatten an inheritance frame's sources + their `@import` children (depth-first,
 *  document order) — mirrors the analyzer's `flatten`. */
function flattenSources(sources: OverheadSource[]): OverheadSource[] {
  const out: OverheadSource[] = [];
  const visit = (s: OverheadSource): void => {
    out.push(s);
    for (const c of s.children ?? []) visit(c);
  };
  for (const s of sources) visit(s);
  return out;
}

/** Extract the deterministic knowledge graph for one already-analyzed agent.
 *  Pure over `(agent, file contents)`; the caller stamps `generatedAtIso`. */
export function extractAgentKnowledge(
  agent: AgentContextOverhead,
  deps: KnowledgeExtractDeps,
  opts: KnowledgeExtractOpts = {},
): { agentId: string; agentName: string; nodes: KnowledgeNode[]; sourceFiles: KnowledgeSourceFile[] } {
  const nodes: KnowledgeNode[] = [];
  const sourceFiles: KnowledgeSourceFile[] = [];
  const parsedPaths = new Set<string>(); // dedupe skill-header/skill-body pairs + overlaps

  // 1. Config surfaces — VERBATIM from the walk-up inheritance chain (A11).
  for (const frame of agent.inheritanceChain) {
    if (!frame.included) continue;
    for (const src of flattenSources(frame.sources)) {
      const abs = src.resolvedPath;
      if (!abs || !src.exists) continue;
      if (!MARKDOWN_KINDS.has(src.kind)) continue;
      if (parsedPaths.has(abs)) continue;
      parsedPaths.add(abs);

      const before = nodes.length;
      const role = roleForSource(src.kind, frame.dir, opts.workspaceRoot);

      // Skills are themselves a tool the agent can invoke → one `tool` node,
      // plus the body's structural nodes.
      if (SKILL_KINDS.has(src.kind)) {
        nodes.push({
          type: 'tool',
          label: clip(`skill: ${skillName(abs)}`, LABEL_MAX),
          detail: src.label,
          source: { absPath: abs, lineStart: 1, lineEnd: 1 },
          sourceScope: src.sourceScope,
          sourceRole: 'skill',
          sourceKind: src.kind,
        });
      }

      const content = deps.readFile(abs);
      if (content !== null) {
        const parsed = parseMarkdownNodes(content, abs, src.sourceScope, role, src.kind);
        // WP2 (G2): nodes carry their source's provider audience so downstream
        // liveness/costing can filter by who actually loads the guidance.
        const audience = src.guidanceSource?.audienceProviders;
        if (audience !== undefined) for (const n of parsed) n.audienceProviders = audience;
        nodes.push(...parsed);
      }

      sourceFiles.push({
        absPath: abs,
        scope: src.sourceScope,
        kind: src.kind,
        label: src.label,
        nodeCount: nodes.length - before,
      });
    }
  }

  // 2. MCP servers granted to this lane → tool nodes (mcpInventory.forLane, A11).
  //    Strict-mode-excluded servers are named-but-not-loaded → still surfaced so
  //    the agent's granted surface is complete, but flagged in the detail.
  for (const server of agent.mcpServers) {
    if (!server.grantedToAgent) continue;
    const detailBits = [`${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`];
    if (server.excludedByStrictMode) detailBits.push('excluded by strict mode');
    if (!server.schemaSourced) detailBits.push('schema not sourced');
    nodes.push({
      type: 'tool',
      label: clip(`mcp: ${server.displayName}`, LABEL_MAX),
      detail: detailBits.join(' · '),
      source: { absPath: server.configPath ?? '', lineStart: 1, lineEnd: 1 },
      sourceScope: 'agent',
      sourceRole: 'mcp',
      sourceKind: 'mcp-tool-schema',
    });
  }

  return { agentId: agent.id, agentName: agent.name, nodes, sourceFiles };
}
