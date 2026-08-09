// Planning-surface mechanics WP-D2: the single server-side package transition
// service. Mutable package state is only a projection of the append-only evidence
// written here. Existing writers are rerouted by WP-D3.

import {
  getContinuationAttempt,
  getDb,
  getPackageFinalization,
  getPlanPackageEvidenceProjection,
  getPlanWorkPackage,
  getPlanWpReachabilityClearance,
  getTurnRecord,
  insertContinuationHandoffResultEvent,
  insertPlanPackageDeploymentEvent,
  insertPlanPackageGateAttempt,
  insertPlanPackageGateCommitLink,
  listContinuationHandoffResultEvents,
  listPlanPackageGateCommitLinks,
  listPlanWpReachabilityObligations,
  upsertCommitRecord,
  upsertCommitTurnLink,
  type CommitRecord,
  type ContinuationHandoffResultKind,
  type ContinuationHandoffResultOutcome,
  type PlanPackageDeploymentState,
  type PlanPackageGateOutcome,
  type PlanWorkPackage,
  type PlanWorkPackageState,
} from '../database';

type PackageIdentity = {
  idempotencyKey: string;
  workspaceId: string;
  planId: string;
  planArtifactId: string;
  intentId: string;
  packageId: string;
  packageRevision: number;
};

export type CommitRef = { repositoryKey: string; commitOid: string };

export type CompletionDeclaration =
  | {
      kind: 'code';
      requiredGateKeys: readonly string[];
      implementationCommits: readonly CommitRef[];
      requireDispatch?: boolean;
      boundary: 'ready' | 'committed';
      deploymentEnvironments: readonly string[];
      behavior?: boolean;
    }
  | {
      kind: 'research';
      requiredGateKeys: readonly string[];
      outputFinalizationId: string;
    }
  | {
      kind: 'no-change';
      reviewGateKey: string;
    };

export type PlanPackageCommand =
  | (PackageIdentity & { type: 'dispatch-confirmed'; dispatchAttemptId: string })
  | (PackageIdentity & { type: 'block'; reason: string })
  | (PackageIdentity & { type: 'unblock'; reason: string })
  | (PackageIdentity & {
      type: 'gate-decided'; gateKey: string; gateRevision: number;
      attemptNo: number; finalizationId?: string | null;
    })
  | (PackageIdentity & { type: 'commits-observed' })
  | (PackageIdentity & { type: 'deployment-observed' })
  | (PackageIdentity & { type: 'complete'; declaration: CompletionDeclaration })
  | (PackageIdentity & { type: 'reopen'; reason: string })
  | (PackageIdentity & { type: 'archive'; reason: string });

type BaseWitness = { actor: string; observedAt: number };
export type PlanPackageWitness =
  | (BaseWitness & { kind: 'dispatch'; confirmedTurnId: string })
  | (BaseWitness & { kind: 'operator' })
  | (BaseWitness & {
      kind: 'gate'; outcome: PlanPackageGateOutcome;
      witnessAgentId?: string | null; witnessSessionId?: string | null;
      witnessTurnId?: string | null; evidence?: unknown;
      verifiedCommits?: readonly CommitRef[];
    })
  | (BaseWitness & { kind: 'git'; turnId: string; commits: readonly CommitRecord[] })
  | (BaseWitness & {
      kind: 'deployment'; environment: string; state: PlanPackageDeploymentState;
      repositoryKey?: string | null; commitOid?: string | null;
      witnessAgentId?: string | null; witnessSessionId?: string | null; detail?: unknown;
    })
  | (BaseWitness & {
      kind: 'completion'; candidateTreeOid?: string;
      verificationTargetVersion?: string;
      mutationBlobOidByObligationId?: Readonly<Record<string, string>>;
    });

export interface TransitionResult {
  commandType: PlanPackageCommand['type'];
  idempotencyKey: string;
  packageId: string;
  packageRevision: number;
  stateBefore: PlanWorkPackageState;
  stateAfter: PlanWorkPackageState;
  stateChanged: boolean;
  evidenceIds: string[];
  replayed: boolean;
}

type Marker = {
  version: 1; digest: string; result: Omit<TransitionResult, 'replayed'>;
  evidence?: unknown;
};
const MARKER_PREFIX = 'package-ledger:v1:';
const HANDOFF_MARKER_PREFIX = 'handoff-ledger:v1:';
const FULL_OID = /^[0-9a-f]{40}$/i;

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function digestOf(command: PlanPackageCommand, witness: PlanPackageWitness): string {
  // The timestamp is deliberately excluded: a retry is the same observed command,
  // not a new decision merely because its delivery was retried later.
  const { observedAt: _observedAt, ...stableWitness } = witness;
  return canonical({ command, witness: stableWitness });
}

function markerText(marker: Marker): string { return MARKER_PREFIX + JSON.stringify(marker); }
function readMarker(raw: unknown): Marker | null {
  if (typeof raw !== 'string') return null;
  const at = raw.lastIndexOf(MARKER_PREFIX);
  if (at < 0) return null;
  try { return JSON.parse(raw.slice(at + MARKER_PREFIX.length)) as Marker; } catch { return null; }
}

function commandRowId(key: string): string {
  if (!key.trim()) throw new Error('package-ledger: idempotencyKey must be non-empty');
  return `package-ledger:${key}`;
}

function findPrior(key: string): Marker | null {
  const db = getDb();
  const id = commandRowId(key);
  const candidates = [
    db.prepare('SELECT reason AS marker FROM plan_wp_lifecycle_events WHERE id = ?').get(id),
    db.prepare('SELECT evidence_json AS marker FROM plan_package_gate_attempts WHERE id = ?').get(id),
    db.prepare('SELECT detail_json AS marker FROM plan_package_deployment_events WHERE id = ?').get(id),
  ] as Array<{ marker?: unknown } | undefined>;
  const links = db.prepare(
    `SELECT capture_quality AS marker FROM commit_turn_links
      WHERE capture_quality LIKE ?`,
  ).all(`%${MARKER_PREFIX}%`) as Array<{ marker?: unknown }>;
  candidates.push(...links.filter((row) => readMarker(row.marker)?.result.idempotencyKey === key));
  const markers = candidates.map((row) => readMarker(row?.marker)).filter((m): m is Marker => m !== null);
  if (markers.length > 1 && markers.some((m) => canonical(m) !== canonical(markers[0]))) {
    throw new Error(`package-ledger: corrupt duplicate idempotency key ${key}`);
  }
  return markers[0] ?? null;
}

function assertIdentity(command: PackageIdentity): PlanWorkPackage {
  const pkg = getPlanWorkPackage(command.packageId);
  if (!pkg) throw new Error(`package-ledger: no package ${command.packageId}`);
  if (pkg.projectionStatus === 'legacy-unmigrated') {
    throw new Error(`package-ledger: package ${command.packageId} is quarantined`);
  }
  if (pkg.workspaceId !== command.workspaceId || pkg.planId !== command.planId
      || pkg.intentId !== command.intentId || pkg.revision !== command.packageRevision) {
    throw new Error('package-ledger: package identity/revision mismatch');
  }
  const db = getDb();
  const plan = db.prepare(
    'SELECT workspace_id, artifact_id FROM plans WHERE id = ?',
  ).get(command.planId) as { workspace_id: string; artifact_id: string | null } | undefined;
  if (!plan || plan.workspace_id !== command.workspaceId || plan.artifact_id !== command.planArtifactId) {
    throw new Error('package-ledger: plan artifact identity mismatch');
  }
  const intent = db.prepare(
    `SELECT 1 AS ok FROM plan_intents
      WHERE plan_id = ? AND workspace_id = ? AND plan_artifact_id = ? AND intent_id = ?`,
  ).get(command.planId, command.workspaceId, command.planArtifactId, command.intentId);
  if (!intent) throw new Error('package-ledger: intent identity mismatch');
  return pkg;
}

function requireWitness<T extends PlanPackageWitness['kind']>(
  witness: PlanPackageWitness, kind: T,
): Extract<PlanPackageWitness, { kind: T }> {
  if (witness.kind !== kind) throw new Error(`package-ledger: ${kind} witness required`);
  return witness as Extract<PlanPackageWitness, { kind: T }>;
}

function assertEdge(command: PlanPackageCommand, state: PlanWorkPackageState): PlanWorkPackageState {
  switch (command.type) {
    case 'dispatch-confirmed': if (state === 'ready') return 'executing'; break;
    case 'block': if (state === 'executing') return 'blocked'; break;
    case 'unblock': if (state === 'blocked') return 'executing'; break;
    case 'gate-decided': if (state === 'executing' || state === 'blocked') return state; break;
    case 'commits-observed':
    case 'deployment-observed': if (state === 'executing' || state === 'blocked') return state; break;
    case 'complete': if (state === 'executing') return 'done'; break;
    case 'reopen': if (state === 'done' || state === 'archived') return 'ready'; break;
    case 'archive': if (state !== 'archived') return 'archived'; break;
  }
  throw new Error(`package-ledger: illegal ${command.type} edge from ${state}`);
}

function appendStateProjection(
  command: PlanPackageCommand, witness: BaseWitness, from: PlanWorkPackageState,
  to: PlanWorkPackageState, marker: Marker, primaryId?: string,
): string | null {
  if (from === to) return null;
  const id = primaryId ?? commandRowId(command.idempotencyKey);
  getDb().prepare(
    `INSERT INTO plan_wp_lifecycle_events
       (id, package_id, plan_id, from_state, to_state, actor, reason, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, command.packageId, command.planId, from, to, witness.actor, markerText(marker), witness.observedAt);
  getDb().prepare(
    'UPDATE plan_work_packages SET state = ?, updated_at = ? WHERE id = ?',
  ).run(to, witness.observedAt, command.packageId);
  return id;
}

function requireCompletion(command: Extract<PlanPackageCommand, { type: 'complete' }>, witness: PlanPackageWitness): void {
  const completion = requireWitness(witness, 'completion');
  const projection = getPlanPackageEvidenceProjection(command.packageId, command.packageRevision);
  if (!projection) throw new Error('package-ledger: package evidence unavailable');
  const latestGates = new Map(projection.latestGateAttempts.map((gate) => [gate.gateKey, gate]));
  const requireGates = (keys: readonly string[]): void => {
    for (const key of keys) {
      if (latestGates.get(key)?.outcome !== 'passed') {
        throw new Error(`package-ledger: required gate '${key}' has not passed`);
      }
    }
  };

  const declaration = command.declaration;
  if (declaration.kind === 'code') {
    requireGates(declaration.requiredGateKeys);
    if (declaration.requireDispatch !== false && !projection.dispatchAttempts.some(
      (attempt) => attempt.packageRevision === command.packageRevision
        && attempt.confirmedTurnId !== null && (attempt.state === 'delivered' || attempt.state === 'reconciled'),
    )) throw new Error('package-ledger: confirmed dispatch required');
    if (declaration.implementationCommits.length === 0) {
      throw new Error('package-ledger: code package requires implementation commits');
    }
    for (const ref of declaration.implementationCommits) {
      if (!FULL_OID.test(ref.commitOid)) throw new Error('package-ledger: full commit OID required');
      const record = getDb().prepare(
        'SELECT 1 AS ok FROM commit_records WHERE repository_key = ? AND commit_oid = ?',
      ).get(ref.repositoryKey, ref.commitOid);
      if (!record) throw new Error(`package-ledger: implementation commit ${ref.commitOid} not observed`);
      const covered = declaration.requiredGateKeys.some((key) => {
        const gate = latestGates.get(key);
        return gate?.outcome === 'passed' && listPlanPackageGateCommitLinks(gate.id)
          .some((link) => link.repositoryKey === ref.repositoryKey && link.commitOid === ref.commitOid);
      });
      if (!covered) throw new Error(`package-ledger: implementation commit ${ref.commitOid} is not gate-covered`);
    }
    const finalization = projection.package.revision === command.packageRevision
      ? getDb().prepare(
          `SELECT boundary_status, lifecycle_status FROM package_finalizations
            WHERE package_id = ? AND package_revision = ? ORDER BY finalized_at DESC LIMIT 1`,
        ).get(command.packageId, command.packageRevision) as
          { boundary_status: string; lifecycle_status: string } | undefined
      : undefined;
    if (!finalization || finalization.boundary_status !== 'ready'
        || finalization.lifecycle_status !== (declaration.boundary === 'ready' ? 'active' : 'committed')) {
      throw new Error(`package-ledger: ${declaration.boundary} finalization boundary required`);
    }
    const latestDeployments = new Map(projection.latestDeploymentEvents.map((event) => [event.environment, event.state]));
    for (const environment of declaration.deploymentEnvironments) {
      const state = latestDeployments.get(environment);
      if (state !== 'deployed' && state !== 'not_required') {
        throw new Error(`package-ledger: terminal deployment evidence required for ${environment}`);
      }
    }
    if (declaration.deploymentEnvironments.length === 0 || projection.latestDeploymentEvents.length === 0) {
      throw new Error('package-ledger: explicit deployment state required');
    }
    const obligations = listPlanWpReachabilityObligations(command.packageId);
    if (obligations.length > 0) {
        if (!completion.candidateTreeOid || !completion.verificationTargetVersion
            || !completion.mutationBlobOidByObligationId) {
          throw new Error('package-ledger: reachability freshness witness required');
        }
        const clearance = getPlanWpReachabilityClearance({
          packageId: command.packageId,
          candidateTreeOid: completion.candidateTreeOid,
          verificationTargetVersion: completion.verificationTargetVersion,
          mutationBlobOidByObligationId: completion.mutationBlobOidByObligationId,
        });
        if (!clearance.cleared) throw new Error('package-ledger: reachability obligations are not freshly cleared');
    }
  } else if (declaration.kind === 'research') {
    requireGates(declaration.requiredGateKeys);
    const output = getPackageFinalization(declaration.outputFinalizationId);
    if (!output || output.packageId !== command.packageId
        || output.packageRevision !== command.packageRevision
        || output.boundaryStatus !== 'ready'
        || (output.lifecycleStatus !== 'active' && output.lifecycleStatus !== 'committed')) {
      throw new Error('package-ledger: durable research output required');
    }
  } else {
    const review = latestGates.get(declaration.reviewGateKey);
    if (!review || review.outcome !== 'passed') throw new Error('package-ledger: reviewed justification required');
    let evidence: unknown;
    try {
      const raw = review.evidenceJson?.startsWith(MARKER_PREFIX)
        ? JSON.parse(review.evidenceJson.slice(MARKER_PREFIX.length)) as Marker : null;
      evidence = raw?.evidence ?? null;
    } catch { evidence = null; }
    const justification = (evidence as { reviewedJustification?: unknown } | null)?.reviewedJustification;
    if (typeof justification !== 'string' || !justification.trim()) {
      throw new Error('package-ledger: reviewed justification required');
    }
  }
}

export function transitionPlanPackage(
  command: PlanPackageCommand, witness: PlanPackageWitness,
): TransitionResult {
  const digest = digestOf(command, witness);
  return getDb().transaction((): TransitionResult => {
    const prior = findPrior(command.idempotencyKey);
    if (prior) {
      if (prior.digest !== digest) throw new Error(`package-ledger: conflicting idempotency key ${command.idempotencyKey}`);
      return { ...prior.result, replayed: true };
    }
    const pkg = assertIdentity(command);
    let to = assertEdge(command, pkg.state);
    const primaryId = commandRowId(command.idempotencyKey);
    const evidenceIds: string[] = [];

    if (command.type === 'dispatch-confirmed') {
      const observed = requireWitness(witness, 'dispatch');
      const attempt = getDb().prepare('SELECT * FROM plan_dispatch_attempts WHERE id = ?').get(
        command.dispatchAttemptId,
      ) as Record<string, unknown> | undefined;
      const turn = getTurnRecord(observed.confirmedTurnId);
      if (!attempt || attempt.package_id !== command.packageId || attempt.plan_id !== command.planId
          || attempt.package_revision !== command.packageRevision || attempt.intent_id !== command.intentId
          || attempt.state === 'failed' || !turn || turn.planId !== command.planId
          || turn.planItemId !== command.packageId || turn.intentId !== command.intentId
          || turn.agentId !== attempt.target_agent_id) {
        throw new Error('package-ledger: dispatch confirmation is not witnessed by a matching turn');
      }
      getDb().prepare(
        `UPDATE plan_dispatch_attempts SET state = 'delivered', confirmed_turn_id = ?,
           confirmed_at = ?, target_session_id = COALESCE(target_session_id, ?) WHERE id = ?`,
      ).run(turn.id, observed.observedAt, turn.sessionId, command.dispatchAttemptId);
      evidenceIds.push(command.dispatchAttemptId);
    } else if (command.type === 'gate-decided') {
      const observed = requireWitness(witness, 'gate');
      if (observed.outcome === 'failed' && pkg.state === 'executing') to = 'blocked';
      if (command.finalizationId) {
        const finalization = getPackageFinalization(command.finalizationId);
        if (!finalization || finalization.packageId !== command.packageId
            || finalization.packageRevision !== command.packageRevision) {
          throw new Error('package-ledger: gate finalization mismatch');
        }
      }
      // Marker is filled below after the result is known. Gate evidence is first
      // assembled here, then inserted once with that durable marker.
    } else if (command.type === 'commits-observed') {
      const observed = requireWitness(witness, 'git');
      const turn = getTurnRecord(observed.turnId);
      if (!turn || turn.planId !== command.planId || turn.planItemId !== command.packageId
          || turn.intentId !== command.intentId) {
        throw new Error('package-ledger: commits require a matching stamped turn');
      }
      if (observed.commits.length === 0) throw new Error('package-ledger: no commits observed');
      for (const record of observed.commits) {
        if (!FULL_OID.test(record.commitOid)) throw new Error('package-ledger: full commit OID required');
        upsertCommitRecord(record);
      }
    } else if (command.type === 'deployment-observed') {
      requireWitness(witness, 'deployment');
    } else if (command.type === 'complete') {
      requireCompletion(command, witness);
    } else {
      requireWitness(witness, 'operator');
    }

    const predictedEvidenceIds = command.type === 'dispatch-confirmed'
      ? [command.dispatchAttemptId, primaryId]
      : command.type === 'gate-decided'
      ? [primaryId, ...(pkg.state !== to ? [`${primaryId}:state`] : [])]
      : command.type === 'deployment-observed'
        ? [primaryId]
        : command.type === 'commits-observed'
          ? requireWitness(witness, 'git').commits.map(
              (record) => `${record.repositoryKey}:${record.commitOid}:${requireWitness(witness, 'git').turnId}`,
            )
          : pkg.state !== to ? [primaryId] : evidenceIds;
    const baseResult: Omit<TransitionResult, 'replayed'> = {
      commandType: command.type, idempotencyKey: command.idempotencyKey,
      packageId: command.packageId, packageRevision: command.packageRevision,
      stateBefore: pkg.state, stateAfter: to, stateChanged: pkg.state !== to,
      evidenceIds: predictedEvidenceIds,
    };
    const marker: Marker = {
      version: 1, digest, result: baseResult,
      ...(command.type === 'gate-decided'
        ? { evidence: requireWitness(witness, 'gate').evidence ?? null } : {}),
    };

    if (command.type === 'gate-decided') {
      const observed = requireWitness(witness, 'gate');
      insertPlanPackageGateAttempt({
        id: primaryId, workspaceId: command.workspaceId, planId: command.planId,
        planArtifactId: command.planArtifactId, intentId: command.intentId,
        packageId: command.packageId, packageRevision: command.packageRevision,
        gateKey: command.gateKey, gateRevision: command.gateRevision,
        attemptNo: command.attemptNo, outcome: observed.outcome,
        finalizationId: command.finalizationId ?? null,
        witnessAgentId: observed.witnessAgentId ?? null,
        witnessSessionId: observed.witnessSessionId ?? null,
        witnessTurnId: observed.witnessTurnId ?? null,
        evidenceJson: markerText(marker), decidedAt: observed.observedAt, createdAt: observed.observedAt,
      });
      evidenceIds.push(primaryId);
      for (const ref of observed.verifiedCommits ?? []) {
        const present = getDb().prepare(
          'SELECT 1 AS ok FROM commit_records WHERE repository_key = ? AND commit_oid = ?',
        ).get(ref.repositoryKey, ref.commitOid);
        if (!present) throw new Error(`package-ledger: gate cannot cover unobserved commit ${ref.commitOid}`);
        insertPlanPackageGateCommitLink({ gateAttemptId: primaryId, ...ref, createdAt: observed.observedAt });
      }
      if (pkg.state !== to) appendStateProjection(command, witness, pkg.state, to, marker, `${primaryId}:state`);
    } else if (command.type === 'deployment-observed') {
      const observed = requireWitness(witness, 'deployment');
      insertPlanPackageDeploymentEvent({
        id: primaryId, workspaceId: command.workspaceId, planId: command.planId,
        packageId: command.packageId, packageRevision: command.packageRevision,
        environment: observed.environment, state: observed.state,
        repositoryKey: observed.repositoryKey ?? null, commitOid: observed.commitOid ?? null,
        witnessAgentId: observed.witnessAgentId ?? null,
        witnessSessionId: observed.witnessSessionId ?? null,
        detailJson: markerText(marker), occurredAt: observed.observedAt,
      });
      evidenceIds.push(primaryId);
    } else if (command.type === 'commits-observed') {
      const observed = requireWitness(witness, 'git');
      for (const record of observed.commits) {
        const existing = getDb().prepare(
          `SELECT relation, capture_quality FROM commit_turn_links
            WHERE repository_key = ? AND commit_oid = ? AND turn_id = ?`,
        ).get(record.repositoryKey, record.commitOid, observed.turnId) as
          { relation: 'candidate_member' | 'exact_path_match' | 'metadata_only'; capture_quality: string | null } | undefined;
        const durableMarker = markerText(marker);
        upsertCommitTurnLink({
          repositoryKey: record.repositoryKey, commitOid: record.commitOid,
          turnId: observed.turnId, planId: command.planId, planItemId: command.packageId,
          relation: existing?.relation ?? 'candidate_member',
          captureQuality: existing?.capture_quality
            ? `${existing.capture_quality}\n${durableMarker}` : durableMarker,
        });
        evidenceIds.push(`${record.repositoryKey}:${record.commitOid}:${observed.turnId}`);
      }
    } else {
      const eventId = appendStateProjection(command, witness, pkg.state, to, marker);
      if (eventId) evidenceIds.push(eventId);
    }
    return { ...baseResult, replayed: false };
  })();
}

export interface HandoffResultCommand {
  idempotencyKey: string;
  handoffAttemptId: string;
  resultKind: ContinuationHandoffResultKind;
  brickId?: string | null;
  sourceSessionId?: string | null;
  successorSessionId?: string | null;
  kickoffTurnId?: string | null;
}

export interface HandoffResultWitness {
  outcome: ContinuationHandoffResultOutcome;
  witnessedAt: number;
  completionQuality?: string | null;
  detail?: unknown;
}

export function recordHandoffResult(command: HandoffResultCommand, witness: HandoffResultWitness) {
  return getDb().transaction(() => {
    const id = `handoff-ledger:${command.handoffAttemptId}:${command.idempotencyKey}`;
    const digest = canonical({ command, witness: { ...witness, witnessedAt: undefined } });
    const prior = listContinuationHandoffResultEvents(command.handoffAttemptId).find((event) => event.id === id);
    if (prior) {
      let stored: { digest?: string } | null = null;
      try {
        stored = prior.detailJson?.startsWith(HANDOFF_MARKER_PREFIX)
          ? JSON.parse(prior.detailJson.slice(HANDOFF_MARKER_PREFIX.length)) : null;
      } catch { stored = null; }
      if (stored?.digest !== digest) throw new Error(`handoff-ledger: conflicting idempotency key ${command.idempotencyKey}`);
      return { ...prior, replayed: true };
    }
    const attempt = getContinuationAttempt(command.handoffAttemptId);
    if (!attempt) throw new Error(`handoff-ledger: no attempt ${command.handoffAttemptId}`);
    if (command.resultKind === 'brick_saved' && witness.outcome === 'succeeded') {
      const brick = command.brickId && getDb().prepare(
        'SELECT 1 AS ok FROM continuation_bricks WHERE id = ? AND handoff_attempt_id = ?',
      ).get(command.brickId, command.handoffAttemptId);
      if (!brick) throw new Error('handoff-ledger: succeeded brick_saved requires a durable matching brick');
    }
    if (command.resultKind === 'successor_started' && witness.outcome === 'succeeded'
        && !command.successorSessionId) {
      throw new Error('handoff-ledger: succeeded successor_started requires successor session');
    }
    if (command.resultKind === 'successor_oriented' && witness.outcome === 'succeeded') {
      const turn = command.kickoffTurnId ? getTurnRecord(command.kickoffTurnId) : null;
      if (!turn || turn.sessionId !== command.successorSessionId || turn.status === 'open') {
        throw new Error('handoff-ledger: succeeded successor_oriented requires a completed kickoff turn');
      }
    }
    const event = {
      id, handoffAttemptId: command.handoffAttemptId, resultKind: command.resultKind,
      outcome: witness.outcome, dashboardAgentId: attempt.dashboardAgentId,
      generation: attempt.generation, brickId: command.brickId ?? null,
      sourceSessionId: command.sourceSessionId ?? null,
      successorSessionId: command.successorSessionId ?? null,
      kickoffTurnId: command.kickoffTurnId ?? null,
      completionQuality: witness.completionQuality ?? null,
      detailJson: HANDOFF_MARKER_PREFIX + JSON.stringify({ digest, detail: witness.detail ?? null }),
      witnessedAt: witness.witnessedAt,
    };
    insertContinuationHandoffResultEvent(event);
    return { ...event, replayed: false };
  })();
}
