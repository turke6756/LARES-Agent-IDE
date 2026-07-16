// WP4 — anchor minting, registration, backfill + diff (R1 WP4 ⊕ R2 §4.3).
//
// Anchors are server-minted, opaque, and immutable once assigned: `sec_` + 6
// base32 for sections, `blk_` + 6 base32 for lazy sub-blocks. Both fit the
// F-D validation shape /^(sec|blk)_[a-z0-9]{6}$/.
//
//   registerSectionsFromHtml — parse → INSERT the anchored sections, MINT +
//     patch the anchorless ones (backfill; trusted, server-side), and
//     SOFT-ARCHIVE anchors that disappeared from the HTML (F-E: archived_at set,
//     never DELETE, plan_events never dropped).
//   registerBlocksFromHtml   — lazily mint + patch `blk_` anchors for a section's
//     notable blocks (R2 §4.3), only when asked (outline / blk read).
//   diffSectionAnchors       — set diff of prior vs current anchors (appeared /
//     disappeared) — feeds archive + observed-anchor attribution.
//
// DB access is injected (SectionRegistryDeps) so registration is unit-testable
// without a live database; `dbSectionRegistryDeps()` wires the real helpers.

import crypto from 'crypto';
import { parsePlanHtml, type PlanProjection, type ParsedSection } from './section-reader';
import {
  getPlanSections, insertPlanSection, archivePlanSection, getPlanSectionByAnchor,
  type PlanSectionRow,
} from '../database';

// base32hex lowercase — a subset of [a-z0-9], so minted anchors satisfy F-D's
// /^(sec|blk)_[a-z0-9]{6}$/ shape. 32^6 ≈ 1e9 keyspace per prefix.
const BASE32 = '0123456789abcdefghijklmnopqrstuv';

function mint6(): string {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += BASE32[bytes[i] & 31];
  return out;
}

export function mintSectionAnchor(): string { return `sec_${mint6()}`; }
export function mintBlockAnchor(): string { return `blk_${mint6()}`; }

export const ANCHOR_SHAPE = /^(sec|blk)_[a-z0-9]{6}$/;
export function isValidAnchor(anchor: string | null | undefined): boolean {
  return typeof anchor === 'string' && ANCHOR_SHAPE.test(anchor);
}

// ── pure HTML patching (backfill) ────────────────────────────────────────────

/**
 * Insert ` data-anchor="…"` into each anchorless section's opening tag, minting
 * a fresh `sec_` anchor for it. Insertions are applied RIGHT-TO-LEFT (descending
 * offset) so earlier offsets stay valid. Returns the patched HTML + the mints
 * (in document order). Idempotent: a projection with no anchorless section
 * returns the source unchanged and an empty mint list.
 *
 * `mint` is injectable so tests can assert deterministic output.
 */
export function patchAnchorlessSections(
  html: string,
  projection: PlanProjection,
  mint: () => string = mintSectionAnchor,
): { html: string; minted: { anchor: string; zone: string | null }[] } {
  const anchorless = projection.sections
    .filter((s) => !s.anchor)
    .sort((a, b) => b.startOffset - a.startOffset); // right-to-left
  if (anchorless.length === 0) return { html, minted: [] };

  const minted: { anchor: string; zone: string | null }[] = [];
  let patched = html;
  for (const s of anchorless) {
    const anchor = mint();
    minted.unshift({ anchor, zone: s.zone }); // restore document order
    const insertAt = s.startOffset + 1 + s.tagName.length; // just after `<tagName`
    patched = patched.slice(0, insertAt) + ` data-anchor="${anchor}"` + patched.slice(insertAt);
  }
  return { html: patched, minted };
}

/** Mint + patch `blk_` anchors for notable, still-anchorless blocks across ALL
 *  sections of a projection. Only blocks with NO data-anchor are touched (author
 *  anchors are surfaced by the reader, never re-stamped → no duplicate attrs).
 *  Right-to-left insertion keeps earlier offsets valid. Idempotent. */
export function patchAnchorlessBlocks(
  html: string,
  projection: PlanProjection,
  mint: () => string = mintBlockAnchor,
): { html: string; minted: string[] } {
  const targets = projection.sections
    .flatMap((s) => s.blocks)
    .filter((b) => b.isLazyCandidate && !b.anchor)
    .sort((a, b) => b.startOffset - a.startOffset); // right-to-left
  if (targets.length === 0) return { html, minted: [] };
  const minted: string[] = [];
  let patched = html;
  for (const b of targets) {
    const anchor = mint();
    minted.unshift(anchor);
    const insertAt = b.startOffset + 1 + b.tagName.length; // just after `<tag`
    patched = patched.slice(0, insertAt) + ` data-anchor="${anchor}"` + patched.slice(insertAt);
  }
  return { html: patched, minted };
}

// ── anchor set diff ──────────────────────────────────────────────────────────

/** Set diff of two anchor lists — which appeared / disappeared between reparses. */
export function diffSectionAnchors(prev: string[], next: string[]): {
  appeared: string[]; disappeared: string[];
} {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    appeared: next.filter((a) => !prevSet.has(a)),
    disappeared: prev.filter((a) => !nextSet.has(a)),
  };
}

// ── DB-backed registration ───────────────────────────────────────────────────

export interface SectionRegistryDeps {
  getPlanSections(planId: string, opts?: { includeArchived?: boolean }): PlanSectionRow[];
  getPlanSectionByAnchor(planId: string, anchor: string): PlanSectionRow | null;
  insertPlanSection(input: { planId: string; anchor: string; parentSectionId?: string | null; createdAt?: string }): string;
  archivePlanSection(planId: string, anchor: string, archivedAt?: string): void;
}

export function dbSectionRegistryDeps(): SectionRegistryDeps {
  return { getPlanSections, getPlanSectionByAnchor, insertPlanSection, archivePlanSection };
}

export interface RegisterResult {
  /** Possibly-patched HTML (anchorless sections got minted data-anchors). Equal
   *  to the input when nothing was minted → caller can skip the file write. */
  html: string;
  /** Re-parsed projection over the FINAL (patched) HTML. */
  projection: PlanProjection;
  htmlChanged: boolean;
  /** Section mints only (`sec_`) — never contains block mints, so no downstream
   *  section-mint consumer suddenly sees a `blk_`. */
  mintedAnchors: string[];
  /** Block mints (`blk_`) from the anchorless-notable-block pass (I-6 Part 2). */
  mintedBlockAnchors: string[];
  archivedAnchors: string[];
  warnings: string[];
}

/**
 * Register a reparse into `plan_sections` (R1 §2, F-E). Steps:
 *  1. Parse; mint + patch anchorless sections (backfill, server-side/trusted).
 *  2. Re-parse the patched HTML so every section now carries an anchor.
 *  3. INSERT (idempotent) each live anchor — a reappeared archived anchor
 *     un-archives inside insertPlanSection.
 *  4. SOFT-ARCHIVE anchors that were registered-and-live but are now absent
 *     (archived_at set; never DELETE; plan_events untouched).
 *
 * Never throws on anchor corruption — duplicates/anchorless become warnings.
 */
export function registerSectionsFromHtml(
  deps: SectionRegistryDeps,
  planId: string,
  html: string,
  now?: string,
): RegisterResult {
  // One parse→patch→reparse chain, two patch passes (sections, then blocks),
  // feeding the SINGLE whole-file backfill write downstream in watch-plans.
  const firstPass = parsePlanHtml(html);
  const secPatch = patchAnchorlessSections(html, firstPass);
  const afterSections = secPatch.html;
  const sectionProjection = afterSections !== html ? parsePlanHtml(afterSections) : firstPass;

  const blockPatch = patchAnchorlessBlocks(afterSections, sectionProjection);
  const finalHtml = blockPatch.html;
  const projection = finalHtml !== afterSections ? parsePlanHtml(finalHtml) : sectionProjection;
  const htmlChanged = finalHtml !== html;

  // Live anchors present in the (patched) HTML.
  const liveAnchors = projection.sections
    .map((s) => s.anchor)
    .filter((a): a is string => !!a);
  const liveSet = new Set(liveAnchors);

  // (3) Insert/refresh every live anchor (idempotent; un-archives reappearances).
  for (const anchor of liveSet) {
    deps.insertPlanSection({ planId, anchor, createdAt: now });
  }

  // (4) Soft-archive previously-live anchors now absent from the HTML.
  const archivedAnchors: string[] = [];
  for (const row of deps.getPlanSections(planId, { includeArchived: false })) {
    if (!liveSet.has(row.anchor)) {
      deps.archivePlanSection(planId, row.anchor, now);
      archivedAnchors.push(row.anchor);
    }
  }

  return {
    html: finalHtml,
    projection,
    htmlChanged,
    mintedAnchors: secPatch.minted.map((m) => m.anchor),
    mintedBlockAnchors: blockPatch.minted,
    archivedAnchors,
    warnings: projection.warnings,
  };
}

/**
 * Lazily mint + patch `blk_` anchors for the notable, still-anchorless blocks of
 * one section (R2 §4.3). Returns patched HTML + the mints. DB rows for blocks are
 * optional in v1 (hierarchy via parent_section_id is designed but blocks live in
 * the HTML); this patches the HTML so the block becomes addressable + immutable.
 *
 * @deprecated Superseded by {@link patchAnchorlessBlocks}, which mints across ALL
 * sections in the single `registerSectionsFromHtml` parse→patch→write chain
 * (I-6). This per-section variant is unused but retained (still correct) to avoid
 * removing an exported, tested helper. New callers should use
 * `registerSectionsFromHtml` (whole-projection) or `patchAnchorlessBlocks`.
 */
export function registerBlocksFromHtml(
  sectionAnchor: string,
  html: string,
  mint: () => string = mintBlockAnchor,
): { html: string; minted: string[] } {
  const proj = parsePlanHtml(html);
  const section = proj.sections.find((s) => s.anchor === sectionAnchor);
  if (!section) return { html, minted: [] };

  const targets = section.blocks
    .filter((b) => b.isLazyCandidate && !b.anchor)
    .sort((a, b) => b.startOffset - a.startOffset); // right-to-left
  if (targets.length === 0) return { html, minted: [] };

  const minted: string[] = [];
  let patched = html;
  for (const b of targets) {
    const anchor = mint();
    minted.unshift(anchor);
    const insertAt = b.startOffset + 1 + b.tagName.length;
    patched = patched.slice(0, insertAt) + ` data-anchor="${anchor}"` + patched.slice(insertAt);
  }
  return { html: patched, minted };
}

/** Convenience: live (non-archived) section anchors for a plan, HTML-order. */
export function liveAnchorsOf(projection: PlanProjection): string[] {
  return projection.sections.map((s: ParsedSection) => s.anchor).filter((a): a is string => !!a);
}
