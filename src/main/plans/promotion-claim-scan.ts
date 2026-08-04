// WP-P3-wire — production claim-scan for proposal promotion (§R-P3 points 9, 11).
//
// The WP-P3B-core `promoteProposal` front half is policy-complete but leaves the
// claim-scan as an injected seam (`ClaimScanFn`). This module is that seam's live
// filesystem body: it scans the §R0-valid plan folders under a workspace's plans
// home and classifies whether one already CLAIMS this proposal, keyed on disk-truth
// `plan.json.source_proposal.artifact_id` (never private dispatch metadata, ruling
// 25). It writes NOTHING — a pure read over the folder set — and reuses
// `validatePlanFolder` (the SAME §R0 validity the watcher enforces) so a claim can
// only come from a folder the watcher would itself adopt.
//
// Classification (matches `ClaimScanResult`):
//   • exactly one valid folder claims the proposal  → claimed (retain ITS identity)
//   • more than one valid folder claims it          → duplicate (blocks, never rebound)
//   • none claim it, BUT the deterministic target folder exists and claims a
//     DIFFERENT proposal                            → foreign (rejected, never rebound)
//   • otherwise                                     → none (derive the deterministic id)

import * as fs from 'fs';
import * as path from 'path';
import { validatePlanFolder } from './plan-folder-watcher';
import type { ClaimScanFn, ClaimScanResult } from './promote-proposal';

/** The minimal filesystem surface the scan needs — injectable so the classifier is
 *  unit-testable without a real plans tree. Defaults to the real `fs`. */
export interface ClaimScanFsDeps {
  /** Absolute plans-home root for a workspace (`<workspaceStateDir()>/plans`). */
  resolvePlansHomeRoot: (workspaceId: string) => string | Promise<string>;
  /** List immediate child directory names of a plans-home root (default: fs). */
  listFolderNames?: (plansHomeRoot: string) => string[];
  /** Read a folder's disk-truth `source_proposal.artifact_id` + `plan_artifact_id`
   *  from its `plan.json`, ONLY when the folder is a valid §R0 plan folder; returns
   *  null for a stray / malformed / non-plan directory (default: fs + validate). */
  readFolderClaim?: (folderAbs: string) => { planArtifactId: string; sourceProposalArtifactId: string | null } | null;
}

function defaultListFolderNames(plansHomeRoot: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(plansHomeRoot, { withFileTypes: true });
  } catch {
    return []; // absent home → no folders → nothing claims
  }
  return entries
    .filter((e) => e.isDirectory())
    // Reject a plan-folder that is itself a reparse point escaping plans/.
    .filter((e) => {
      try { return !fs.lstatSync(path.join(plansHomeRoot, e.name)).isSymbolicLink(); }
      catch { return false; }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

function defaultReadFolderClaim(
  folderAbs: string,
): { planArtifactId: string; sourceProposalArtifactId: string | null } | null {
  const validity = validatePlanFolder(folderAbs);
  if (!validity.valid) return null; // stray / malformed / no-artifact-id → not a claimant
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(path.join(folderAbs, 'plan.json'), 'utf-8'));
  } catch {
    return null;
  }
  const sp = (json as { source_proposal?: { artifact_id?: unknown } } | null)?.source_proposal;
  const sourceProposalArtifactId =
    sp && typeof sp.artifact_id === 'string' && sp.artifact_id !== '' ? sp.artifact_id : null;
  return { planArtifactId: validity.planArtifactId, sourceProposalArtifactId };
}

/** Split a state-dir-relative folder path into its plans-home prefix + basename,
 *  tolerating back-slashes / a trailing slash (`.lares/plans/<sku>` → `.lares/plans`
 *  + `<sku>`). */
function splitHomeAndName(deterministicFolderRelPath: string): { homeRel: string; name: string } {
  const norm = deterministicFolderRelPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx < 0
    ? { homeRel: '', name: norm }
    : { homeRel: norm.slice(0, idx), name: norm.slice(idx + 1) };
}

/**
 * Build the production `ClaimScanFn`. `resolvePlansHomeRoot` yields the absolute
 * plans-home root (the same one WP-P3B-enrich resolves); the returned function is
 * pure-read and safe to call on every promote / reconcile.
 */
export function makePromotionClaimScan(deps: ClaimScanFsDeps): ClaimScanFn {
  const listFolderNames = deps.listFolderNames ?? defaultListFolderNames;
  const readFolderClaim = deps.readFolderClaim ?? defaultReadFolderClaim;

  return async (input): Promise<ClaimScanResult> => {
    const plansHomeRoot = await deps.resolvePlansHomeRoot(input.workspaceId);
    const { homeRel, name: deterministicName } = splitHomeAndName(input.deterministicFolderRelPath);
    const toRelPath = (folderName: string): string => (homeRel ? `${homeRel}/${folderName}` : folderName);

    const claimants: { planArtifactId: string; folderRelPath: string }[] = [];
    let deterministicForeign: { folderRelPath: string; diagnostic: string } | null = null;

    for (const folderName of listFolderNames(plansHomeRoot)) {
      const claim = readFolderClaim(path.join(plansHomeRoot, folderName));
      if (!claim) continue;
      if (claim.sourceProposalArtifactId === input.proposalArtifactId) {
        claimants.push({ planArtifactId: claim.planArtifactId, folderRelPath: toRelPath(folderName) });
      } else if (
        folderName === deterministicName &&
        claim.sourceProposalArtifactId !== null &&
        claim.sourceProposalArtifactId !== input.proposalArtifactId
      ) {
        // The deterministic target path is occupied by a folder claiming a DIFFERENT
        // proposal — reject rather than silently rebind onto it.
        deterministicForeign = {
          folderRelPath: toRelPath(folderName),
          diagnostic:
            `deterministic target ${toRelPath(folderName)} is claimed by a different proposal ` +
            `(source_proposal.artifact_id=${claim.sourceProposalArtifactId}, requested=${input.proposalArtifactId})`,
        };
      }
    }

    if (claimants.length > 1) {
      return {
        kind: 'duplicate',
        folderRelPaths: claimants.map((c) => c.folderRelPath),
        diagnostic:
          `${claimants.length} valid folders claim proposal ${input.proposalArtifactId}: ` +
          claimants.map((c) => c.folderRelPath).join(', '),
      };
    }
    if (claimants.length === 1) {
      return { kind: 'claimed', planArtifactId: claimants[0].planArtifactId, folderRelPath: claimants[0].folderRelPath };
    }
    if (deterministicForeign) {
      return { kind: 'foreign', folderRelPath: deterministicForeign.folderRelPath, diagnostic: deterministicForeign.diagnostic };
    }
    return { kind: 'none' };
  };
}
