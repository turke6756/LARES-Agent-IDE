// Context-Overhead — structural config-weight classifier (Wave-2 §C3 / req 3).
//
// Decomposes each RESIDENT config surface (CLAUDE.md / rules / settings) into
// heading-bounded sections (shared `splitIntoSections`) and assigns each a
// STRUCTURAL weight class. This is EVIDENCE, not a behavioral verdict:
//
//   ── BEHAVIOR SEAM (§D) ─────────────────────────────────────────────────────
//   This classifier must NEVER emit `live` or `dead`. Those two statuses require
//   an observed-behavior corpus (a later agent-knowledge / optimizer plan) and
//   are reserved in `SectionWeightClass` so the type + UI stay stable until that
//   plan populates them. Here we emit ONLY:
//     structurally-broken | insufficient-evidence | unobservable | not-analyzed
//   ───────────────────────────────────────────────────────────────────────────
//
// Pure except for the injected `FileReader` already in the analyzer's deps — no
// new IO. Reference resolution is deterministic (regex + set membership), never
// an LLM.

import type {
  ConfigSectionWeight,
  ConfigWeightRollup,
  McpServerOverhead,
  OverheadSource,
  OverheadSourceKind,
  SectionWeightClass,
} from '../../shared/types';
import { MAX_READABLE_BYTES } from '../shared/max-readable-bytes';
import { splitIntoSections } from '../shared/markdown-sections';
import type { FileReader } from './context-overhead-analyzer';
import type { PathOps } from './paths';
import type { TokenEstimator } from './token-estimator';

// Resident config surfaces whose prose we decompose into sections. Skill/memory/
// behavioral/import/mcp rows are deliberately excluded — they are not free-form
// config guidance. WP2 (G2): applicable AGENTS.md rows (`agents-md`) join the
// sectioned set; their sections carry the source's GuidanceSource record and are
// rolled up PER fileKind, never summed into the Claude-config bucket.
const CONFIG_KINDS: ReadonlySet<OverheadSourceKind> = new Set<OverheadSourceKind>([
  'agent-claude', 'inherited-claude', 'claude-local', 'user-claude',
  'managed-policy', 'rules', 'settings-hooks', 'agents-md',
]);

const ALL_CLASSES: SectionWeightClass[] = [
  'live', 'dead', 'structurally-broken', 'insufficient-evidence', 'unobservable', 'not-analyzed',
];

/** A fresh, all-zero `tokensByClass` with every one of the six keys present. */
export function emptyTokensByClass(): Record<SectionWeightClass, number> {
  const out = {} as Record<SectionWeightClass, number>;
  for (const c of ALL_CLASSES) out[c] = 0;
  return out;
}

// ── reference extraction (deterministic) ──────────────────────────────────────

type RefKind = 'file' | 'skill' | 'mcp';
interface Reference { kind: RefKind; raw: string; target: string; }

/** Resolves references against data already on the agent — no new IO beyond the
 *  injected reader. */
export interface ReferenceResolver {
  fileExists(fromDir: string, ref: string): boolean;
  skillGranted(name: string): boolean;
  mcpGranted(server: string): boolean;
  /** Candidate MCP names to scan the prose for (id/displayName variants), each
   *  tagged with whether it is granted-and-counted for this agent. */
  mcpNames: Array<{ token: string; granted: boolean }>;
}

export function buildResolver(
  flatSources: OverheadSource[],
  mcpServers: McpServerOverhead[],
  reader: FileReader,
  pathOps: PathOps,
  workspaceRoot: string,
): ReferenceResolver {
  const skillNames = new Set<string>();
  for (const s of flatSources) {
    if ((s.kind === 'skill-header' || s.kind === 'skill-body') && s.resolvedPath) {
      const m = /\/skills\/([^/]+)\/skill\.md$/i.exec(s.resolvedPath.replace(/\\/g, '/'));
      if (m) skillNames.add(m[1].toLowerCase());
    }
  }

  const grantedMcp = new Set<string>();
  const nameTokens = new Map<string, boolean>(); // token → granted
  for (const srv of mcpServers) {
    const granted = srv.grantedToAgent && !srv.excludedByStrictMode;
    for (const tok of mcpTokenVariants(srv)) {
      if (granted) grantedMcp.add(tok);
      // First writer wins "granted:true" so a granted variant isn't overwritten.
      if (!nameTokens.has(tok) || granted) nameTokens.set(tok, granted);
    }
  }

  return {
    fileExists(fromDir, ref) {
      const clean = ref.replace(/[.,;:)]+$/, ''); // trailing punctuation from prose
      const cands = [pathOps.join(fromDir, clean), pathOps.join(workspaceRoot, clean)];
      if (pathOps.isAbsolute(clean)) cands.push(pathOps.resolve(clean));
      return cands.some((c) => reader.exists(c));
    },
    skillGranted(name) { return skillNames.has(name.toLowerCase()); },
    mcpGranted(server) { return grantedMcp.has(server.toLowerCase()); },
    mcpNames: [...nameTokens.entries()].map(([token, granted]) => ({ token, granted })),
  };
}

function mcpTokenVariants(srv: McpServerOverhead): string[] {
  const toks = new Set<string>();
  const add = (v: string) => { const t = v.toLowerCase().trim(); if (t.length >= 3) toks.add(t); };
  add(srv.id);
  add(srv.displayName);
  add(srv.displayName.replace(/^agent-/, '')); // 'agent-dashboard' → 'dashboard'
  add(srv.id.replace(/^agent-/, ''));
  return [...toks];
}

/** Extract file/skill/mcp references from one section's prose. Deduped by
 *  (kind, target). */
function extractReferences(text: string, resolver: ReferenceResolver): Reference[] {
  const out: Reference[] = [];
  const seen = new Set<string>();
  const add = (kind: RefKind, raw: string, target: string) => {
    const key = `${kind}:${target.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, raw, target });
  };

  // Fully-qualified MCP tools: mcp__server__tool → server segment is the target.
  for (const m of text.matchAll(/mcp__([a-z0-9-]+)__([a-z0-9_]+)/gi)) add('mcp', m[0], m[1]);

  // File & script paths: ./x, ../x, or any token ending in a known code/doc ext.
  for (const m of text.matchAll(/(?:\.{1,2}\/[\w./\-]+|[\w./\-]+\.(?:md|sh|js|ts|json|py))/g)) {
    add('file', m[0], m[0]);
  }

  // Skill directories: /skills/<name>/
  for (const m of text.matchAll(/\/skills\/([\w-]+)\//gi)) add('skill', m[0], m[1]);

  // MCP server/toolset name mentions — only names this agent actually has (granted
  // OR excluded), so an ungranted-lane mention becomes a structurally-broken ref.
  const lower = text.toLowerCase();
  for (const { token } of resolver.mcpNames) {
    const re = new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(token)}(?:[^a-z0-9_-]|$)`, 'i');
    if (re.test(lower)) add('mcp', token, token);
  }

  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── per-section classification ────────────────────────────────────────────────

function classifySectionText(
  text: string,
  sourceDir: string,
  resolver: ReferenceResolver,
): { weightClass: SectionWeightClass; evidence: string[] } {
  const refs = extractReferences(text, resolver);
  if (refs.length === 0) {
    return { weightClass: 'unobservable', evidence: ['no verifiable file/skill/tool references'] };
  }
  const resolved: string[] = [];
  const broken: string[] = [];
  for (const ref of refs) {
    if (ref.kind === 'file') {
      if (resolver.fileExists(sourceDir, ref.target)) resolved.push(`references ${ref.raw} — resolves`);
      else broken.push(`references ${ref.raw} — file not found`);
    } else if (ref.kind === 'skill') {
      if (resolver.skillGranted(ref.target)) resolved.push(`references skill '${ref.target}' — granted`);
      else broken.push(`references skill '${ref.target}' — not granted to this lane`);
    } else {
      if (resolver.mcpGranted(ref.target)) resolved.push(`mentions '${ref.target}' MCP — granted`);
      else broken.push(`mentions '${ref.target}' MCP — not granted to this lane`);
    }
  }
  if (resolved.length === 0) return { weightClass: 'structurally-broken', evidence: broken };
  // ≥1 reference resolves structurally, but we have NO behavior data to say live/dead.
  return { weightClass: 'insufficient-evidence', evidence: [...resolved, ...broken] };
}

// ── public entry ──────────────────────────────────────────────────────────────

/** Classify every RESIDENT config surface in `flatSources` into weighted sections.
 *  BEHAVIOR SEAM (§D): never emits `live`/`dead`. */
export function classifyAgentConfig(
  flatSources: OverheadSource[],
  mcpServers: McpServerOverhead[],
  reader: FileReader,
  estimator: TokenEstimator,
  pathOps: PathOps,
  workspaceRoot: string,
): ConfigWeightRollup {
  const resolver = buildResolver(flatSources, mcpServers, reader, pathOps, workspaceRoot);
  const sections: ConfigSectionWeight[] = [];

  for (const src of flatSources) {
    if (!CONFIG_KINDS.has(src.kind)) continue;
    if (!src.exists || !src.resolvedPath) continue;
    // Skip dedup placeholders (same file counted via a nearer scope) so we don't
    // classify one file twice.
    if ((src.warnings ?? []).some((w) => w.toLowerCase().includes('dedup'))) continue;

    const path = src.resolvedPath;
    const file = reader.read(path);
    if (!file) {
      sections.push(oneSection(src, '(file)', 0, 1, 1, estimator.estimate('').tokens,
        'not-analyzed', ['file could not be read']));
      continue;
    }
    if (file.content.length > MAX_READABLE_BYTES) {
      sections.push(oneSection(src, '(file)', 0, 1, 1, estimator.estimate('').tokens,
        'not-analyzed', [`file exceeds the max-readable cap (${MAX_READABLE_BYTES} bytes)`]));
      continue;
    }

    const sourceDir = pathOps.dirname(path);
    for (const sec of splitIntoSections(file.content)) {
      const { weightClass, evidence } = classifySectionText(sec.text, sourceDir, resolver);
      sections.push({
        sourcePath: path,
        sourceLabel: src.label,
        scope: src.sourceScope,
        heading: sec.heading,
        startLine: sec.startLine,
        endLine: sec.endLine,
        tokens: estimator.estimate(sec.text).tokens,
        weightClass,
        evidence,
        // WP2 (G2): thread the owning source's guidance record through so the
        // section is joinable to its provider audience + chain applicability.
        ...(src.guidanceSource ? { guidanceSource: src.guidanceSource } : {}),
      });
    }
  }

  return {
    sections,
    tokensByClass: rollupTokens(sections),
    tokensByClassByFileKind: rollupTokensByFileKind(sections),
  };
}

function oneSection(
  src: OverheadSource,
  heading: string,
  _level: number,
  startLine: number,
  endLine: number,
  tokens: number,
  weightClass: SectionWeightClass,
  evidence: string[],
): ConfigSectionWeight {
  return {
    sourcePath: src.resolvedPath!,
    sourceLabel: src.label,
    scope: src.sourceScope,
    heading,
    startLine,
    endLine,
    tokens,
    weightClass,
    evidence,
  };
}

/** WP2 (G2): the rollup bucket key for a section — its guidance fileKind, or the
 *  legacy 'claude-config' bucket for config surfaces without a GuidanceSource
 *  record (rules / settings / pre-WP2 fixtures). */
export function fileKindBucketOf(s: ConfigSectionWeight): string {
  return s.guidanceSource?.fileKind ?? 'claude-config';
}

/**
 * Sum section tokens into the six-key bucket map (all keys always present).
 * WP2 (G2): this headline rollup NEVER sums across `fileKind` — AGENTS.md
 * sections are excluded here and appear only in their own
 * `rollupTokensByFileKind` bucket. The pre-WP2 population (CLAUDE-family +
 * rules + settings) is unchanged.
 */
export function rollupTokens(sections: ConfigSectionWeight[]): Record<SectionWeightClass, number> {
  const by = emptyTokensByClass();
  for (const s of sections) {
    if (fileKindBucketOf(s) === 'agents-md') continue; // never summed across fileKind
    by[s.weightClass] += s.tokens;
  }
  return by;
}

/** WP2 (G2): per-fileKind six-key buckets. Consumers must never sum across keys. */
export function rollupTokensByFileKind(
  sections: ConfigSectionWeight[],
): Record<string, Record<SectionWeightClass, number>> {
  const out: Record<string, Record<SectionWeightClass, number>> = {};
  for (const s of sections) {
    const bucket = fileKindBucketOf(s);
    (out[bucket] ??= emptyTokensByClass())[s.weightClass] += s.tokens;
  }
  return out;
}
