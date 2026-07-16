// resident-inventory.ts — WP5 module 1. The config_section_anchors / config_epochs
// WRITER (hardening-epochs-outcomes.md §1–§2, Fix-6: CREATEs land in WP2, writers
// here). It turns the RESIDENT config surface a lane inherits into a per-section
// residency ledger so the occurrence classifier can bound exposure to the span a
// section was actually resident.
//
// Design pillars:
//  - **No rescan.** The list of resident sources comes VERBATIM from WP1's walk-up
//    chain (`analyzeOverhead` → `AgentContextOverhead.inheritanceChain`), never a
//    hand-listed set of paths (A11). We only re-read each source's *text* to cut it
//    into sections; we never re-run the overhead scan.
//  - **Section, not file, is the residency unit** (§0). A whole-file scaffold
//    rewrite that leaves one section byte-identical keeps that section's epoch open.
//  - **Deterministic day-one ledger.** Anchor precedence is sentinel → constant-meta
//    → toolset → heading-path (§2.2); fuzzy lineage ships OFF (OPTIMIZER_CONFIG).
//
// Persisted-identity note (load-bearing): the DDL declares `anchor_uid` a GLOBAL
// PRIMARY KEY, but §2.2's raw tier values (`sentinel:teams`, `h:foo`) are only
// unique *within* a target. To satisfy the global PK without collisions we persist
// the fully-namespaced `section_key` (= `${target_type}:${target_key}:${rawAnchor}`)
// into BOTH `anchor_uid` and `section_key`. `rawAnchor` (the §2.2 lineage-stable
// component) is embedded inside. Joins by either column are equivalent.
//
// Seams left for WP5 worker #2 (clearly marked below):
//  - §3 cold-start git backfill: injected via `BirthdayResolver`; default resolver
//    dates every new section 'none'/now. `git-history.ts` + `config-epoch-backfill.ts`
//    supply the git section-hash resolver.
//  - §2.1 cross-workspace scaffold-constant pooling: injected via `ScaffoldMatcher`;
//    default is per-path identity (honest, just not yet pooled).
//  - §2.4 cross-target move + §2.5(2d) fuzzy tier: removed sections close as
//    'removed'; the move/fuzzy refinement plugs into `reconcileTarget`.
//  - §3.4 toolset-grant residency: `deriveAnchor` emits the 'toolset' tier, but the
//    grant WRITER (corpus-floor birthday) belongs with config-drift (module 5).

import { createHash } from 'node:crypto';
import type {
  AgentContextOverhead,
  AgentRoleLane,
  OverheadModel,
  OverheadSource,
  OverheadSourceKind,
} from '../../shared/types';
import type { FileReader } from '../context-overhead/context-overhead-analyzer';
import { OPTIMIZER_CONFIG, RESIDENT_PARSER_VERSION } from './optimizer-config';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type ConfigTargetType = 'markdown_section' | 'toolset_grant';
export type AnchorKind = 'sentinel' | 'constant_meta' | 'toolset' | 'heading_path' | 'inferred';
export type ConfigSourceKind =
  | 'tracked_file' | 'scaffold_constant' | 'ignored_scaffold' | 'code_constant' | 'user_file';
export type FirstSeenSource =
  | 'observed' | 'git_section_history' | 'git_blame' | 'scaffold_constant' | 'mtime' | 'none';
export type FirstSeenConfidence = 'high' | 'medium' | 'low';

/** One parsed markdown section (the smallest enclosing heading section, §0). */
export interface ParsedSection {
  headingText: string | null;   // heading text w/o leading #; null for a preamble section
  headingLevel: number;         // 1–6; 0 for preamble
  headingPath: string;          // '>'-joined slugged ancestor breadcrumb (incl. self)
  lineStart: number;            // 1-indexed
  lineEnd: number;              // 1-indexed inclusive
  rawHeadingLine: string;       // the heading line verbatim (incl. #); '' for preamble
  body: string;                 // lines after the heading up to the next heading
  sentinelName: string | null;  // §2.2 tier-1 sentinel name (version stripped), else null
}

/** A parsed section with its derived identity — the unit the diff matches on. */
export interface SectionCandidate extends ParsedSection {
  rawAnchor: string;            // §2.2 tier value, e.g. 'sentinel:teams' | 'h:foo>bar' | 'h:foo:1'
  anchorKind: AnchorKind;
  contentHash: string;          // sha256(normalize(heading + body))
  semanticFingerprint: string;  // sha256(normalize(body only)) — heading excluded
}

/** A resident config target to reconcile into the ledger (one file OR one grant). */
export interface ResidentTarget {
  targetType: ConfigTargetType;
  targetKey: string;            // §2.1 identity (abs path OR pooled constant symbol)
  sourceKind: ConfigSourceKind;
  sourcePath: string;           // resident path OR constant location
  sourceSymbol?: string | null; // e.g. 'SUPERVISOR_AGENT_MD'
  lanes: AgentRoleLane[];       // lanes inheriting this target (drives lanes_json)
  text: string;                 // current on-disk content
}

/** Birthday oracle for a NEW section (§3.2). Module 1 ships the 'none' default;
 *  worker #2's git resolver overrides it for the one-shot cold-start backfill. */
export interface BirthdayResolver {
  resolve(target: ResidentTarget, section: SectionCandidate, nowMs: number):
    { firstSeenMs: number; source: FirstSeenSource; confidence: FirstSeenConfidence };
}

/** §3.2 tier-5 default: undatable ⇒ first_seen = firstParseMs, source 'none'. Honest —
 *  such a section reads `insufficient-exposure`, never killable. */
export const noneBirthdayResolver: BirthdayResolver = {
  resolve: (_t, _s, nowMs) => ({ firstSeenMs: nowMs, source: 'none', confidence: 'low' }),
};

/** Optional pooling oracle (§2.1). Given a section's text + resident path, returns a
 *  pooled constant identity when the content matches a managed scaffold constant.
 *  Default (undefined) ⇒ per-path identity. Supplied by worker #2's backfill. */
export interface ScaffoldMatcher {
  match(target: { sourcePath: string; text: string; lane: AgentRoleLane }):
    { targetKey: string; sourceKind: ConfigSourceKind; sourceSymbol: string } | null;
}

// Minimal write surface — the real better-sqlite3 handle OR the sql.js test fake.
export interface LedgerStatement {
  run(params?: Record<string, unknown>): { changes: number };
  get(params?: Record<string, unknown>): Record<string, unknown> | undefined;
  all(params?: Record<string, unknown>): Record<string, unknown>[];
}
export interface LedgerDb { prepare(sql: string): LedgerStatement }

export interface ReconcileResult {
  opened: number;    // new epochs (brand-new sections)
  edited: number;    // close-old + open-new pairs
  unchanged: number; // exact content_hash carry-overs
  closed: number;    // removed sections
}

// ─────────────────────────────────────────────────────────────────────────────
// Hashing + normalization (§2.3)
// ─────────────────────────────────────────────────────────────────────────────

const SENTINEL_OPEN = /^\s*<!--\s*section:([a-z0-9][a-z0-9-]*)\s+v\d+\s*-->\s*$/i;
const SENTINEL_CLOSE = /^\s*<!--\s*\/section:([a-z0-9][a-z0-9-]*)\s*-->\s*$/i;
const SENTINEL_SELF = /^\s*<!--\s*([a-z0-9][a-z0-9-]*)-v\d+\s*-->\s*$/i;
const ANY_SENTINEL_LINE = /^\s*<!--\s*\/?(?:section:)?[a-z0-9][a-z0-9-]*(?:\s+v\d+|-v\d+)?\s*-->\s*$/i;

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** §2.3 normalize: strip sentinel/marker lines; CRLF→LF; collapse blank-line runs to
 *  one; trim trailing per-line whitespace; strip a leading list-marker/`#` on line 1. */
export function normalizeSectionText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
    .filter((l) => !ANY_SENTINEL_LINE.test(l))
    .map((l) => l.replace(/[ \t]+$/, ''));
  if (lines.length > 0) {
    lines[0] = lines[0].replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, '');
  }
  // collapse consecutive blank lines to one, and trim leading/trailing blanks.
  const out: string[] = [];
  for (const l of lines) {
    if (l.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(l);
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out.join('\n');
}

export function contentHashOf(rawHeadingLine: string, body: string): string {
  return sha256Hex(normalizeSectionText(rawHeadingLine + '\n' + body));
}
export function semanticFingerprintOf(body: string): string {
  return sha256Hex(normalizeSectionText(body));
}

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown sectioning (§0) + anchor derivation (§2.2)
// ─────────────────────────────────────────────────────────────────────────────

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;

/** Cut markdown into heading sections. Content before the first heading becomes a
 *  preamble section (level 0) only when it carries non-blank text. */
export function parseMarkdownSections(text: string): ParsedSection[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  // ── sentinel coverage: innermost open wrapped-sentinel per line + self markers ──
  const openAt: (string | null)[] = new Array(lines.length).fill(null);
  const selfAt: (string | null)[] = new Array(lines.length).fill(null);
  const stack: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = SENTINEL_OPEN.exec(lines[i]);
    const close = SENTINEL_CLOSE.exec(lines[i]);
    const self = SENTINEL_SELF.exec(lines[i]);
    if (open) { openAt[i] = stack[stack.length - 1] ?? null; stack.push(open[1].toLowerCase()); continue; }
    if (close) { if (stack.length && stack[stack.length - 1] === close[1].toLowerCase()) stack.pop(); openAt[i] = stack[stack.length - 1] ?? null; continue; }
    if (self && !open) selfAt[i] = self[1].toLowerCase();
    openAt[i] = stack[stack.length - 1] ?? null;
  }

  // ── heading boundaries ──
  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (HEADING_RE.test(lines[i])) headingIdx.push(i);

  const sections: ParsedSection[] = [];
  const crumb: { level: number; slug: string }[] = [];

  const pushSection = (
    headingLineIdx: number | null, bodyStart: number, bodyEndExcl: number,
  ): void => {
    let headingText: string | null = null;
    let headingLevel = 0;
    let rawHeadingLine = '';
    let path = '';
    if (headingLineIdx !== null) {
      const m = HEADING_RE.exec(lines[headingLineIdx])!;
      headingLevel = m[1].length;
      headingText = m[2].trim();
      rawHeadingLine = lines[headingLineIdx];
      while (crumb.length && crumb[crumb.length - 1].level >= headingLevel) crumb.pop();
      crumb.push({ level: headingLevel, slug: slugify(headingText) || 'section' });
      path = crumb.map((c) => c.slug).join('>');
    }
    const bodyLines = lines.slice(bodyStart, bodyEndExcl);
    const body = bodyLines.join('\n');
    // Skip an empty preamble — use NORMALIZED text so a leading sentinel-open
    // comment (stripped by normalize) doesn't mint a phantom preamble section.
    if (headingLineIdx === null && normalizeSectionText(body) === '') return;
    // sentinel for this section: cover the heading line, else any self/wrapped marker
    // among the section's own lines (before the next heading).
    let sentinelName: string | null = headingLineIdx !== null ? openAt[headingLineIdx] : null;
    if (!sentinelName) {
      const from = headingLineIdx !== null ? headingLineIdx : bodyStart;
      for (let i = from; i < bodyEndExcl; i++) {
        if (selfAt[i]) { sentinelName = selfAt[i]; break; }
        if (openAt[i]) { sentinelName = openAt[i]; break; }
      }
    }
    sections.push({
      headingText, headingLevel, headingPath: path,
      lineStart: (headingLineIdx ?? bodyStart) + 1,
      lineEnd: bodyEndExcl, // exclusive idx == 1-indexed inclusive of last line
      rawHeadingLine, body, sentinelName,
    });
  };

  // preamble (before first heading)
  const firstHeading = headingIdx.length ? headingIdx[0] : lines.length;
  if (firstHeading > 0) pushSection(null, 0, firstHeading);
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h];
    const nextHeading = h + 1 < headingIdx.length ? headingIdx[h + 1] : lines.length;
    pushSection(start, start + 1, nextHeading);
  }
  return sections;
}

/** WP-E (P4) — the parsed section whose 1-indexed line span contains `line`, or null.
 *  SPANS ONLY: parses `text` into sections and returns the innermost (smallest-span)
 *  section covering the line. No tokenizer, no DB, no clock — the grant-mismatch
 *  detector composes this with an injected `estimateTokens` seam to size a resident
 *  section from a drift source anchor (the tokenizer stays OUT of this module). */
export function findSectionContainingLine(text: string, line: number): ParsedSection | null {
  let best: ParsedSection | null = null;
  for (const s of parseMarkdownSections(text)) {
    if (line < s.lineStart || line > s.lineEnd) continue;
    if (!best || s.lineEnd - s.lineStart < best.lineEnd - best.lineStart) best = s;
  }
  return best;
}

/** Derive the §2.2 raw anchor + kind for parsed sections. Heading-path duplicates
 *  under an identical breadcrumb get a `:nthOccurrence` (document order) suffix. */
export function deriveAnchors(sections: ParsedSection[]): SectionCandidate[] {
  const pathCounts = new Map<string, number>();
  for (const s of sections) if (!s.sentinelName) pathCounts.set(s.headingPath, (pathCounts.get(s.headingPath) ?? 0) + 1);
  const seen = new Map<string, number>();
  return sections.map((s) => {
    let rawAnchor: string;
    let anchorKind: AnchorKind;
    if (s.sentinelName) {
      rawAnchor = `sentinel:${s.sentinelName}`;
      anchorKind = 'sentinel';
    } else {
      const n = seen.get(s.headingPath) ?? 0;
      seen.set(s.headingPath, n + 1);
      const dup = (pathCounts.get(s.headingPath) ?? 0) > 1;
      rawAnchor = `h:${s.headingPath}${dup ? `:${n}` : ''}`;
      anchorKind = 'heading_path';
    }
    return {
      ...s, rawAnchor, anchorKind,
      contentHash: contentHashOf(s.rawHeadingLine, s.body),
      semanticFingerprint: semanticFingerprintOf(s.body),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The §2.5 resident-inventory diff + writer (per target)
// ─────────────────────────────────────────────────────────────────────────────

function sectionKeyFor(t: { targetType: string; targetKey: string }, rawAnchor: string): string {
  return `${t.targetType}:${t.targetKey}:${rawAnchor}`;
}

interface OpenEpoch {
  id: string; sectionKey: string; anchorUid: string; rawAnchor: string;
  contentHash: string; semanticFingerprint: string; firstSeenMs: number;
}

/** Reconcile ONE target's current sections against its open epochs (§2.5). Writes
 *  config_section_anchors (upserted pointer) + config_epochs (immutable spans). */
export function reconcileTarget(
  db: LedgerDb,
  target: ResidentTarget,
  opts: { nowMs: number; birthday?: BirthdayResolver; parserVersion?: number },
): ReconcileResult {
  const now = opts.nowMs;
  const birthday = opts.birthday ?? noneBirthdayResolver;
  const parserVersion = opts.parserVersion ?? RESIDENT_PARSER_VERSION;
  const lanesJson = JSON.stringify(target.lanes);

  const current = target.targetType === 'markdown_section'
    ? deriveAnchors(parseMarkdownSections(target.text))
    : [];

  const openRows = db.prepare(
    `SELECT id, section_key, anchor_uid, content_hash, semantic_fingerprint, first_seen_ms
     FROM config_epochs
     WHERE target_type = @tt AND target_key = @tk AND last_seen_ms IS NULL`,
  ).all({ tt: target.targetType, tk: target.targetKey });
  const open: OpenEpoch[] = openRows.map((r) => ({
    id: String(r.id), sectionKey: String(r.section_key), anchorUid: String(r.anchor_uid),
    rawAnchor: String(r.anchor_uid).slice(`${target.targetType}:${target.targetKey}:`.length),
    contentHash: String(r.content_hash), semanticFingerprint: String(r.semantic_fingerprint),
    firstSeenMs: Number(r.first_seen_ms),
  }));

  const usedOpen = new Set<number>();
  type Plan =
    | { kind: 'unchanged'; cur: SectionCandidate; epoch: OpenEpoch }
    | { kind: 'edited'; cur: SectionCandidate; epoch: OpenEpoch }
    | { kind: 'new'; cur: SectionCandidate };
  const plans: Plan[] = [];
  const matchedCur = new Set<number>();

  // greedy one-to-one, in precedence order: (a) content_hash, (b) fingerprint, (c) anchor
  const tryMatch = (pred: (c: SectionCandidate, e: OpenEpoch) => boolean, kind: 'unchanged' | 'edited'): void => {
    current.forEach((cur, ci) => {
      if (matchedCur.has(ci)) return;
      for (let oi = 0; oi < open.length; oi++) {
        if (usedOpen.has(oi)) continue;
        if (pred(cur, open[oi])) {
          usedOpen.add(oi); matchedCur.add(ci);
          plans.push({ kind, cur, epoch: open[oi] } as Plan);
          return;
        }
      }
    });
  };
  tryMatch((c, e) => c.contentHash === e.contentHash, 'unchanged');            // (a)
  tryMatch((c, e) => c.semanticFingerprint === e.semanticFingerprint, 'edited'); // (b) rename
  tryMatch((c, e) => sectionKeyFor(target, c.rawAnchor) === e.anchorUid, 'edited'); // (c) reword
  // (2d) fuzzy tier — OFF by default (OPTIMIZER_CONFIG.ENABLE_FUZZY_LINEAGE).
  current.forEach((cur, ci) => { if (!matchedCur.has(ci)) plans.push({ kind: 'new', cur }); });

  let opened = 0, edited = 0, unchanged = 0, closed = 0;
  const upsertAnchor = (
    anchorUid: string, sectionKey: string, rawAnchor: string, anchorKind: AnchorKind,
    cur: SectionCandidate, createdMs: number,
  ): void => {
    db.prepare(
      `INSERT INTO config_section_anchors
         (anchor_uid, target_type, target_key, section_key, anchor_kind,
          current_source_path, current_heading_text, current_heading_path,
          current_line_start, current_line_end, last_content_hash, last_semantic_fingerprint,
          created_at_ms, updated_at_ms)
       VALUES (@au, @tt, @tk, @sk, @ak, @sp, @ht, @hp, @ls, @le, @ch, @sf, @cm, @um)
       ON CONFLICT(anchor_uid) DO UPDATE SET
         current_source_path=@sp, current_heading_text=@ht, current_heading_path=@hp,
         current_line_start=@ls, current_line_end=@le,
         last_content_hash=@ch, last_semantic_fingerprint=@sf, updated_at_ms=@um`,
    ).run({
      au: anchorUid, tt: target.targetType, tk: target.targetKey, sk: sectionKey, ak: anchorKind,
      sp: target.sourcePath, ht: cur.headingText, hp: cur.headingPath,
      ls: cur.lineStart, le: cur.lineEnd, ch: cur.contentHash, sf: cur.semanticFingerprint,
      cm: createdMs, um: now,
    });
  };
  const openEpoch = (
    sectionKey: string, anchorUid: string, cur: SectionCandidate,
    firstSeenMs: number, source: FirstSeenSource, confidence: FirstSeenConfidence,
  ): string => {
    const id = `${sectionKey}@${firstSeenMs}`;
    db.prepare(
      `INSERT OR IGNORE INTO config_epochs
         (id, section_key, anchor_uid, target_type, target_key, lanes_json, source_kind,
          source_path, source_symbol, heading_text, heading_path, content_hash,
          semantic_fingerprint, first_seen_ms, first_seen_source, first_seen_confidence,
          parser_version, created_at_ms, updated_at_ms)
       VALUES (@id, @sk, @au, @tt, @tk, @lanes, @srck, @sp, @sym, @ht, @hp, @ch, @sf,
               @fsm, @fss, @fsc, @pv, @cm, @um)`,
    ).run({
      id, sk: sectionKey, au: anchorUid, tt: target.targetType, tk: target.targetKey,
      lanes: lanesJson, srck: target.sourceKind, sp: target.sourcePath,
      sym: target.sourceSymbol ?? null, ht: cur.headingText, hp: cur.headingPath,
      ch: cur.contentHash, sf: cur.semanticFingerprint, fsm: firstSeenMs, fss: source,
      fsc: confidence, pv: parserVersion, cm: now, um: now,
    });
    return id;
  };
  const closeEpoch = (id: string, reason: string, supersededBy: string | null): void => {
    db.prepare(
      `UPDATE config_epochs SET last_seen_ms=@ls, last_seen_reason=@r, superseded_by=@sb, updated_at_ms=@um
       WHERE id=@id AND last_seen_ms IS NULL`,
    ).run({ ls: now, r: reason, sb: supersededBy, um: now, id });
  };

  for (const p of plans) {
    if (p.kind === 'unchanged') {
      // Location may have shifted (reorder); refresh the pointer, epoch stays open.
      upsertAnchor(p.epoch.anchorUid, p.epoch.sectionKey, p.epoch.rawAnchor, p.cur.anchorKind, p.cur, p.epoch.firstSeenMs);
      unchanged++;
    } else if (p.kind === 'edited') {
      // Reuse the OLD lineage (anchor/section_key); a reword/rename is born now (A2c).
      // Close BEFORE open — the idx_ce_open partial-unique index forbids two open
      // epochs on one section_key, so the old must close first.
      const newId = `${p.epoch.sectionKey}@${now}`;
      closeEpoch(p.epoch.id, 'edited', newId);
      openEpoch(p.epoch.sectionKey, p.epoch.anchorUid, p.cur, now, 'observed', 'high');
      upsertAnchor(p.epoch.anchorUid, p.epoch.sectionKey, p.epoch.rawAnchor, p.cur.anchorKind, p.cur, p.epoch.firstSeenMs);
      edited++;
    } else {
      // Brand-new section: mint a fresh lineage; date it via the birthday resolver (§3.2).
      const sectionKey = sectionKeyFor(target, p.cur.rawAnchor);
      const b = birthday.resolve(target, p.cur, now);
      openEpoch(sectionKey, sectionKey, p.cur, b.firstSeenMs, b.source, b.confidence);
      upsertAnchor(sectionKey, sectionKey, p.cur.rawAnchor, p.cur.anchorKind, p.cur, b.firstSeenMs);
      opened++;
    }
  }
  // Leftover open epochs → removed. (§2.4 cross-target MOVE reclassification is a
  // documented seam: a post-pass across targets would rewrite reason→'moved_cross_target'.)
  open.forEach((e, oi) => { if (!usedOpen.has(oi)) { closeEpoch(e.id, 'removed', null); closed++; } });

  return { opened, edited, unchanged, closed };
}

// ─────────────────────────────────────────────────────────────────────────────
// OverheadModel extraction (A11 — sources taken VERBATIM from the walk-up chain)
// ─────────────────────────────────────────────────────────────────────────────

// Resident markdown config kinds. Skills (progressive-disclosure) + settings JSON are
// NOT persona residency and are handled by the file-coverage / skill modules.
const MARKDOWN_KINDS = new Set<OverheadSourceKind>([
  'agent-claude', 'inherited-claude', 'claude-local', 'user-claude',
  'managed-policy', 'rules', 'memory', 'behavioral', 'import',
]);

/** §2.6 scan hygiene — never mint phantom epochs from backups / generated files. */
export function isExcludedResidentPath(p: string): boolean {
  const lower = p.replace(/\\/g, '/').toLowerCase();
  if (/\.bak(\.|$)/.test(lower)) return true;
  if (lower.includes('/.scaffold-versions.json')) return true;
  if (/(^|\/)plans\//.test(lower)) return true;
  return false;
}

function flattenSources(sources: OverheadSource[]): OverheadSource[] {
  const out: OverheadSource[] = [];
  const visit = (s: OverheadSource) => { out.push(s); for (const c of s.children ?? []) visit(c); };
  for (const s of sources) visit(s);
  return out;
}

/** Collect resident markdown targets from an already-computed OverheadModel — the
 *  list of sources is taken VERBATIM from each agent's walk-up chain (never
 *  hand-listed, A11); lanes inheriting a path are unioned so exposure spans all of
 *  them. Text is re-read once per unique path (this is NOT a walk-up rescan). */
export function collectMarkdownTargets(
  model: OverheadModel,
  reader: FileReader,
  deps?: { scaffold?: ScaffoldMatcher },
): ResidentTarget[] {
  interface Acc { lanes: Set<AgentRoleLane>; scope: OverheadSource['sourceScope'] }
  const byPath = new Map<string, Acc>();
  const collectAgent = (agent: AgentContextOverhead): void => {
    for (const frame of agent.inheritanceChain) {
      if (!frame.included) continue;
      for (const s of flattenSources(frame.sources)) {
        if (!s.resolvedPath || !MARKDOWN_KINDS.has(s.kind)) continue;
        if (isExcludedResidentPath(s.resolvedPath)) continue;
        const acc = byPath.get(s.resolvedPath) ?? { lanes: new Set<AgentRoleLane>(), scope: s.sourceScope };
        acc.lanes.add(agent.lane);
        byPath.set(s.resolvedPath, acc);
      }
    }
  };
  for (const a of model.agents) collectAgent(a);

  const targets: ResidentTarget[] = [];
  for (const [path, acc] of byPath) {
    const file = reader.read(path);
    if (!file) continue; // missing/unreadable ⇒ nothing to section
    const lanes = [...acc.lanes].sort();
    const pooled = deps?.scaffold?.match({ sourcePath: path, text: file.content, lane: lanes[0] });
    targets.push(pooled
      ? { targetType: 'markdown_section', targetKey: pooled.targetKey, sourceKind: pooled.sourceKind,
          sourcePath: path, sourceSymbol: pooled.sourceSymbol, lanes, text: file.content }
      : { targetType: 'markdown_section', targetKey: normalizePathKey(path),
          sourceKind: classifyPerPathKind(path), sourcePath: path, sourceSymbol: null,
          lanes, text: file.content });
  }
  return targets;
}

function normalizePathKey(p: string): string { return p.replace(/\\/g, '/'); }

/** Per-path source_kind when not pooled to a constant (§2.1): gitignored worker
 *  scaffold ⇒ 'ignored_scaffold'; anything else ⇒ 'user_file' (a diverged/edited
 *  file or a non-scaffold CLAUDE.md). Tracked scaffold personas would pool via the
 *  ScaffoldMatcher seam; absent that, they read as user_file (per-path, honest). */
function classifyPerPathKind(p: string): ConfigSourceKind {
  const lower = normalizePathKey(p).toLowerCase();
  if (lower.includes('/.dashboard/workers/')) return 'ignored_scaffold';
  return 'user_file';
}

/** Top-level WP5 module-1 entrypoint: reconcile every resident markdown target the
 *  model's lanes inherit. Steady-state O(sections), no git. Returns per-target
 *  results keyed by section_key prefix for the caller/UI. */
export function writeResidentInventory(
  db: LedgerDb,
  targets: ResidentTarget[],
  opts: { nowMs: number; birthday?: BirthdayResolver; parserVersion?: number },
): { target: ResidentTarget; result: ReconcileResult }[] {
  return targets.map((target) => ({ target, result: reconcileTarget(db, target, opts) }));
}
