// capstone-map.ts — the ONE capstone registry (master D4), extracted into a
// dependency-free module so BOTH the pure engine (context-optimizer.ts, which
// re-exports these) and the renderer CapstonePanel can import it. Keeping it here —
// rather than in context-optimizer.ts — means the renderer does NOT transitively pull
// the engine's `node:crypto` chain (resident-inventory) into the browser bundle.
//
// Proposal LOGIC still lives in context-optimizer.ts. This file is the mapping table
// + the two pure lookups only; nothing derives a proposal here.

import type { ContextOptimizerProposalKind, ContextOptimizerLever } from '../../shared/types';
import type { MutabilityClass } from '../shared/path-mutability';

export type CapstoneSafetyRoute =
  | 'propose-source-constant-edit'   // generated-vendor: never patch the artifact
  | 'route-to-constants-version-bump'// scaffold-managed: edit src/shared/constants.ts + bump version/previousHashes
  | 'consider-only';                 // user-owned: surface as a suggestion only

export interface CapstoneMapping {
  lever: ContextOptimizerLever;
  capstoneSource: 'behavior-grounded-context-optimizer';
  category: string;                  // capstone card category label
}

export const CAPSTONE_KIND_MAP: Record<ContextOptimizerProposalKind, CapstoneMapping> = {
  'subtract-unused-toolset':          { lever: 'subtract', capstoneSource: 'behavior-grounded-context-optimizer', category: 'Remove unused toolset grant' },
  'subtract-dead-guidance':           { lever: 'subtract', capstoneSource: 'behavior-grounded-context-optimizer', category: 'Remove dead guidance' },
  'subtract-grant-mismatch':          { lever: 'subtract', capstoneSource: 'behavior-grounded-context-optimizer', category: 'Remove grant-mismatched guidance' },
  'subtract-unused-skill-advertisement': { lever: 'subtract', capstoneSource: 'behavior-grounded-context-optimizer', category: 'Remove unused skill advertisement' },
  'tune-split-toolset':               { lever: 'tune',     capstoneSource: 'behavior-grounded-context-optimizer', category: 'Split a broad toolset grant' },
  'add-improvisation-support':        { lever: 'add',      capstoneSource: 'behavior-grounded-context-optimizer', category: 'Support an uncovered improvisation' },
  'add-missing-guidance':             { lever: 'add',      capstoneSource: 'behavior-grounded-context-optimizer', category: 'Add missing guidance' },
  'tune-skill-trigger':               { lever: 'tune',     capstoneSource: 'behavior-grounded-context-optimizer', category: 'Tune a skill trigger' },
  'tune-split-section':               { lever: 'tune',     capstoneSource: 'behavior-grounded-context-optimizer', category: 'Split a mixed-use section' },
  'relocate-to-progressive-disclosure':{ lever: 'relocate', capstoneSource: 'behavior-grounded-context-optimizer', category: 'Relocate to progressive disclosure' },
};

/** P4.2 safety routing (design §7.4) — the single mapping capstone reuses. */
export function safetyRouteFor(mutable: MutabilityClass): CapstoneSafetyRoute {
  switch (mutable) {
    case 'generated-vendor': return 'propose-source-constant-edit';
    case 'scaffold-managed': return 'route-to-constants-version-bump';
    case 'user-owned':       return 'consider-only';
  }
}

export function leverFor(kind: ContextOptimizerProposalKind): ContextOptimizerLever {
  return CAPSTONE_KIND_MAP[kind].lever;
}
