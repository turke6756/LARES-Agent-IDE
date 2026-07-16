// phrase-gap.ts — A9 trigger-phrase gap/lift evidence (WP6).
//
// Spec of record: plans/hardening-classifier-agent-surface.md §3 (algorithm) +
// §1 constants. Secondary: plans/context-optimizer-master-implementation.md
// lines 471–479.
//
// Answers one question, per (lane, skill, bypass-script): which trigger phrases
// did users say when they BYPASSED a skill that are absent/rare in the phrasing
// that legitimately INVOKED it? Those terms are the "your trigger description is
// missing this vocabulary" evidence a tune-skill-trigger card cites.
//
//   BYPASS corpus     = qualifying snippets on WP5 §2.4 bypass exec events.
//   INVOCATION corpus = qualifying snippets on the skill's invocations.
//   (Qualifying = source_kind ∈ (user_message, command_args), selection_reason
//    ='matched'; brief relays excluded. The CALLER applies that filter; this
//    module is a PURE classifier over injected snippet rows — no DB, no clock,
//    no network, no LLM/embedding anywhere by construction, asserted by test.)
//
// Determinism is the whole point: PII redaction BEFORE tokenization, a byte-stable
// tokenize/stopword/casefold pipeline, gap/lift scored in integer BASIS-POINTS (no
// float comparison), min-support floors, and a FULL deterministic tie-break chain
// → same corpus in, byte-identical terms out.
//
// Cards cite terms + counts only — NEVER raw snippet sentences (§3.4).

import type { AgentRoleLane, ProposalPhraseGap } from '../../shared/types';
import {
  OPTIMIZER_CONFIG,
  PHRASE_GAP_STOPWORDS,
  PHRASE_GAP_SHORT_TOKEN_ALLOW,
} from './optimizer-config';

// ─────────────────────────────────────────────────────────────────────────────
// Input / output types
// ─────────────────────────────────────────────────────────────────────────────

/** One qualifying snippet row (§3.1). The caller has already applied the
 *  source_kind / selection_reason filter; we only need the text + the two
 *  dedupe keys. `snippet` is the stored ≤280-char normalized snippet. */
export interface PhraseGapSnippet {
  snippet: string;
  /** Dedupe key for document frequency — identical queries share a hash and
   *  count as ONE document (§3.2 step 5). */
  snippetHash: string;
  /** Cross-session support key — distinct streams containing a term (§3.2 step 5). */
  streamId: string;
}

/** One (lane, skill, bypass-script) unit of work. `scriptPath` is the engine key
 *  the result is filed under (`LaneOptimizerInput.phraseGapByScript[scriptPath]`). */
export interface PhraseGapInput {
  skillName: string;
  lane: AgentRoleLane;
  scriptPath: string;
  invocation: PhraseGapSnippet[];
  bypass: PhraseGapSnippet[];
}

/** One surfaced gap term (§3.4). All scores are integer basis-points. */
export interface PhraseGapTerm {
  term: string;
  gapBps: number;      // floor(10000 * (bypassRate - invokeRate))
  liftBps: number;     // invokeDf===0 ? 999999 : floor(10000 * bypassRate / invokeRate)
  bypassDf: number;    // distinct-hash document frequency in the BYPASS corpus
  invokeDf: number;    // distinct-hash document frequency in the INVOCATION corpus
  bypassStreams: number; // distinct streams in the BYPASS corpus (cross-session support)
}

/** Rich per-unit result (§3.4). Maps to the engine DTO via {@link toProposalPhraseGap}. */
export interface PhraseGap {
  skillName: string;
  lane: AgentRoleLane;
  scriptPath: string;
  status: 'ok' | 'insufficient-phrase-evidence';
  invocationDocs: number;
  bypassDocs: number;
  terms: PhraseGapTerm[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenization pipeline (§3.2) — byte-stable
// ─────────────────────────────────────────────────────────────────────────────

const STOPWORDS: ReadonlySet<string> = new Set(PHRASE_GAP_STOPWORDS);
const SHORT_ALLOW: ReadonlySet<string> = new Set(PHRASE_GAP_SHORT_TOKEN_ALLOW);

/** Redaction passes (§3.2 step 2), applied IN ORDER on the lowercased string.
 *  Each match becomes a single space so a redacted span can never survive as a
 *  term (gap terms are exposed to agents by default — §5.6 — so secrets / paths /
 *  emails / ids must never leak). Order matters: URLs and paths before the
 *  generic KEY=value pass so their internals aren't partially matched. */
const REDACTIONS: ReadonlyArray<RegExp> = [
  /\bhttps?:\/\/\S+/g,                                            // URLs
  /\bwww\.\S+/g,                                                  // bare www URLs
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/g,                   // emails
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, // UUIDs
  /\\\\[^\s]+/g,                                                  // UNC / WSL \\server\share
  /\b[a-z]:[\\/][^\s]*/g,                                         // windows drive paths c:\ , c:/
  /\/(?:[\w.-]+\/)+[\w.-]*/g,                                     // unix absolute / multi-segment paths
  /\b[0-9a-f]{16,}\b/g,                                           // long hex blobs / hashes
  /\b[a-z_][a-z0-9_]{2,}=\S+/g,                                   // KEY=value secret-looking tokens
];

/** Apply NFKC → lowercase → redact. Exposed for the determinism test. */
export function redactAndCasefold(raw: string): string {
  let s = raw.normalize('NFKC').toLowerCase();
  for (const re of REDACTIONS) s = s.replace(re, ' ');
  return s;
}

/** Full tokenizer (§3.2 steps 1–4). Returns tokens in document order; callers
 *  that want document frequency dedupe into a Set. Deterministic and IO-free. */
export function tokenize(raw: string): string[] {
  const s = redactAndCasefold(raw);
  const out: string[] = [];
  const re = /[a-z0-9][a-z0-9_'-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    let tok = m[0];
    // strip leading/trailing quotes and hyphens
    tok = tok.replace(/^[-']+/, '').replace(/[-']+$/, '');
    // strip possessive 's
    if (tok.endsWith("'s")) tok = tok.slice(0, -2);
    if (tok.length === 0) continue;
    if (STOPWORDS.has(tok)) continue;
    if (/^[0-9]+$/.test(tok)) continue;                 // numeric-only
    if (tok.length < 3 && !SHORT_ALLOW.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Corpus analysis (§3.2 step 5)
// ─────────────────────────────────────────────────────────────────────────────

interface CorpusStats {
  /** Distinct documents = distinct snippet_hash (identical queries dedupe). */
  docs: number;
  /** term → distinct-hash document frequency. */
  df: Map<string, number>;
  /** term → distinct streams containing it (cross-session support). */
  streams: Map<string, Set<string>>;
}

/** Roll a corpus of snippet rows into df + stream support. Documents dedupe by
 *  `snippetHash`; stream support counts every row. Tokenized once per distinct
 *  hash so the same text is never re-tokenized. */
function analyzeCorpus(rows: PhraseGapSnippet[]): CorpusStats {
  const tokensByHash = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!tokensByHash.has(r.snippetHash)) {
      tokensByHash.set(r.snippetHash, new Set(tokenize(r.snippet)));
    }
  }
  const df = new Map<string, number>();
  for (const toks of tokensByHash.values()) {
    for (const t of toks) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const streams = new Map<string, Set<string>>();
  for (const r of rows) {
    const toks = tokensByHash.get(r.snippetHash);
    if (!toks) continue;
    for (const t of toks) {
      let set = streams.get(t);
      if (!set) {
        set = new Set();
        streams.set(t, set);
      }
      set.add(r.streamId);
    }
  }
  return { docs: tokensByHash.size, df, streams };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoring + tie-break (§3.3)
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic tie-break: gapBps DESC → liftBps DESC → bypassDf DESC →
 *  invokeDf ASC → term ASC. Plain ASCII compare on the term so output is
 *  byte-identical across platforms/locales. Total order (term is unique). */
function compareTerms(a: PhraseGapTerm, b: PhraseGapTerm): number {
  if (a.gapBps !== b.gapBps) return b.gapBps - a.gapBps;
  if (a.liftBps !== b.liftBps) return b.liftBps - a.liftBps;
  if (a.bypassDf !== b.bypassDf) return b.bypassDf - a.bypassDf;
  if (a.invokeDf !== b.invokeDf) return a.invokeDf - b.invokeDf;
  return a.term < b.term ? -1 : a.term > b.term ? 1 : 0;
}

/**
 * Compute the phrase-gap evidence for one (lane, skill, bypass-script) unit.
 * Pure + deterministic. See §3.
 */
export function computePhraseGap(input: PhraseGapInput): PhraseGap {
  const invocation = analyzeCorpus(input.invocation);
  const bypass = analyzeCorpus(input.bypass);

  const base: Omit<PhraseGap, 'status' | 'terms'> = {
    skillName: input.skillName,
    lane: input.lane,
    scriptPath: input.scriptPath,
    invocationDocs: invocation.docs,
    bypassDocs: bypass.docs,
  };

  // Section gate: enough evidence on BOTH sides to compare at all (§3.3).
  if (
    invocation.docs < OPTIMIZER_CONFIG.PHRASE_GAP_MIN_INVOCATION_SNIPPETS ||
    bypass.docs < OPTIMIZER_CONFIG.PHRASE_GAP_MIN_BYPASS_SNIPPETS
  ) {
    return { ...base, status: 'insufficient-phrase-evidence', terms: [] };
  }

  const terms: PhraseGapTerm[] = [];
  // Only bypass-present terms can be a gap (a term with bypassDf 0 fails the df
  // floor anyway), so iterate the bypass df keys.
  for (const [term, bypassDf] of bypass.df) {
    const bypassStreams = bypass.streams.get(term)?.size ?? 0;
    const invokeDf = invocation.df.get(term) ?? 0;
    const bypassRate = bypassDf / bypass.docs;
    const invokeRate = invokeDf / invocation.docs;
    const gapBps = Math.floor(10000 * (bypassRate - invokeRate));
    const liftBps =
      invokeDf === 0 ? 999999 : Math.floor((10000 * bypassRate) / invokeRate);

    if (
      bypassDf >= OPTIMIZER_CONFIG.PHRASE_GAP_MIN_BYPASS_DF &&
      bypassStreams >= OPTIMIZER_CONFIG.PHRASE_GAP_MIN_BYPASS_STREAMS &&
      gapBps >= OPTIMIZER_CONFIG.PHRASE_GAP_MIN_GAP_BPS &&
      liftBps >= OPTIMIZER_CONFIG.PHRASE_GAP_MIN_LIFT_BPS
    ) {
      terms.push({ term, gapBps, liftBps, bypassDf, invokeDf, bypassStreams });
    }
  }

  terms.sort(compareTerms);
  terms.length = Math.min(terms.length, OPTIMIZER_CONFIG.PHRASE_GAP_MAX_TERMS);

  return { ...base, status: 'ok', terms };
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine mapping — LaneOptimizerInput.phraseGapByScript (do NOT modify the engine)
// ─────────────────────────────────────────────────────────────────────────────

/** Map the rich result to the engine DTO `ProposalPhraseGap` (shared/types.ts).
 *  `bypassCount`/`invocationCount` are the distinct-hash document frequencies.
 *  Returns null for the insufficient-evidence status so the caller can omit the
 *  key entirely rather than plug an empty gap. */
export function toProposalPhraseGap(gap: PhraseGap): ProposalPhraseGap | null {
  if (gap.status !== 'ok' || gap.terms.length === 0) return null;
  return {
    terms: gap.terms.map((t) => ({
      term: t.term,
      bypassCount: t.bypassDf,
      invocationCount: t.invokeDf,
      gapBps: t.gapBps,
      liftBps: t.liftBps,
    })),
  };
}

/** Assemble the engine's `phraseGapByScript` map from a batch of units. Only
 *  status='ok' units with ≥1 surfaced term are keyed; last-writer-wins is avoided
 *  by keying on the distinct `scriptPath` each unit already carries. */
export function buildPhraseGapByScript(
  inputs: PhraseGapInput[],
): Record<string, ProposalPhraseGap> {
  const out: Record<string, ProposalPhraseGap> = {};
  for (const input of inputs) {
    const dto = toProposalPhraseGap(computePhraseGap(input));
    if (dto) out[input.scriptPath] = dto;
  }
  return out;
}
