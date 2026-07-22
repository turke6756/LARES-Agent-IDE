// section-identity.ts — WP5 (G5): the ONE section-identity helper (milestone gate 3).
//
// The optimizer's section identity is the EXISTING key
// `${targetType}:${targetKey}:${rawAnchor}` — MOVED here verbatim from its
// prior sites (guidance-action-model.ts `sectionKeyFor` / resident-inventory.ts
// `sectionKeyFor`, the occurrence plumbing) so that config-weight sections and
// occurrence verdicts derive the SAME key and join without reconstruction.
//
// This is a MOVE, not a new derivation: the composed string is byte-identical
// to what `config_epochs.section_key` / `anchor_uid` have always persisted, so
// epoch continuity is untouched. Do NOT add fields, normalization, or hashing
// here — any change to this composition breaks every persisted epoch identity.
//
// Pure string composition. No IO, no crypto, no Electron — safe for `shared/`.

/** The identity prefix owner (resident-inventory §2.1): a markdown file or a
 *  toolset grant. `targetKey` is the normalized absolute path OR the pooled
 *  scaffold-constant symbol. */
export interface SectionIdentityTarget {
  targetType: string;
  targetKey: string;
}

/** section_key format (mirrors resident-inventory / guidance-action-model
 *  `sectionKeyFor`): `${targetType}:${targetKey}:${rawAnchor}`. The compiler's
 *  key JOINs the ledger the reconciler wrote — and, from WP5 on, the
 *  config-weight section it prices. */
export function sectionKeyFor(target: SectionIdentityTarget, rawAnchor: string): string {
  return `${target.targetType}:${target.targetKey}:${rawAnchor}`;
}

/** Per-path `targetKey` normalization (moved verbatim from resident-inventory's
 *  `normalizePathKey`): backslashes → forward slashes, nothing else. */
export function normalizeSectionPathKey(p: string): string {
  return p.replace(/\\/g, '/');
}
