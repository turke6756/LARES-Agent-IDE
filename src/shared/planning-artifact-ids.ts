export const PROPOSAL_ARTIFACT_ID_RE = /^prop_[0-9a-f]{8}$/;
export const PLAN_ARTIFACT_ID_RE = /^plan_[0-9a-f]{8}$/;
export const PLANNING_INTENT_ID_RE = /^int_[0-9a-f]{8}$/;

export function isProposalArtifactId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ARTIFACT_ID_RE.test(value);
}

export function isPlanArtifactId(value: unknown): value is string {
  return typeof value === 'string' && PLAN_ARTIFACT_ID_RE.test(value);
}

export function isPlanningIntentId(value: unknown): value is string {
  return typeof value === 'string' && PLANNING_INTENT_ID_RE.test(value);
}
