// WP-P8C — the legacy HTML plan reparse pipeline has been retired.
//
// The remaining exports are deliberately inert compatibility seams owned by
// later deletion packages: WP-P8D removes the projection consumers and WP-P8E
// removes the edit-target resolver. Keeping the seams here avoids folding those
// packages into watcher removal while ensuring no file read, parse, anchor
// backfill, change-row write, or snapshot write can occur.

/** Minimal legacy projection shape retained until WP-P8D removes consumers. */
export interface LegacyPlanProjection {
  sections: unknown[];
  parseError: string | null;
  warnings: string[];
  source: string;
}

/** Inert until WP-P8E removes the retired PLAN-EVENT resolver seam. */
export function resolveEditTargetAnchorForPlan(_payload: string | null, _planId: string): null {
  return null;
}

/** Inert until WP-P8D removes the retired HTML projection consumers. */
export function getServedPlanProjection(_planId: string): LegacyPlanProjection | null {
  return null;
}
