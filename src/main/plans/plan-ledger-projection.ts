// WP-D6: the complete plan execution read model. This module intentionally has
// no filesystem import or fallback: a missing ledger row renders as absence.

import type {
  MissionBoardPackageState,
  PlanLedgerBindingState,
  PlanLedgerCommit,
  PlanLedgerDeploymentEvent,
  PlanLedgerDispatchAttempt,
  PlanLedgerGateAttempt,
  PlanLedgerIntent,
  PlanLedgerPackageProjection,
  PlanLedgerProjection,
  PlanLedgerStateEvent,
} from '../../shared/types';
import { getDb } from '../database';

function rows<T>(sql: string, ...params: unknown[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

function row<T>(sql: string, ...params: unknown[]): T | null {
  return (getDb().prepare(sql).get(...params) as T | undefined) ?? null;
}

function parseJson(value: string | null): unknown | null {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; }
  catch { return value; }
}

interface PlanRow {
  plan_id: string;
  workspace_id: string;
  artifact_id: string | null;
  source_proposal_id: string | null;
  run_state: string | null;
  responsible_supervisor_id: string | null;
  source_join_id: string | null;
  source_artifact_id: string | null;
  source_title: string | null;
  source_state: string | null;
}

interface PackageRow {
  package_id: string;
  title: string;
  acceptance_condition: string | null;
  state: MissionBoardPackageState;
  assignee_agent_id: string | null;
  revision: number;
  projection_status: string | null;
  intent_id: string | null;
  intent_join_id: string | null;
  intent_kind: string | null;
  intent_status: string | null;
  intent_reason: string | null;
  integration_note: string | null;
}

function deriveBindingState(plan: PlanRow, pkg: PackageRow): PlanLedgerBindingState {
  if (pkg.projection_status === 'legacy-unmigrated') return 'quarantined';
  return plan.artifact_id !== null
    && plan.source_proposal_id !== null
    && plan.source_join_id !== null
    && pkg.intent_id !== null
    && pkg.intent_join_id !== null
    ? 'bound'
    : 'legacy-unbound';
}

function projectIntent(pkg: PackageRow): PlanLedgerIntent | null {
  if (pkg.intent_join_id === null || pkg.intent_id === null
      || pkg.intent_kind === null || pkg.intent_status === null) return null;
  return {
    intentId: pkg.intent_id,
    kind: pkg.intent_kind,
    status: pkg.intent_status,
    reason: pkg.intent_reason,
    integrationNote: pkg.integration_note,
  };
}

function dispatchAttempts(packageId: string, revision: number): PlanLedgerDispatchAttempt[] {
  return rows<{
    id: string; state: string; target_agent_id: string | null; target_agent_title: string | null;
    target_session_id: string | null; confirmed_session_id: string | null;
    orchestration_id: string | null; confirmed_turn_id: string | null;
    created_at: number; confirmed_at: number | null;
  }>(
    `SELECT d.id, d.state, d.target_agent_id, a.title AS target_agent_title,
            d.target_session_id, t.session_id AS confirmed_session_id,
            d.orchestration_id, d.confirmed_turn_id, d.created_at, d.confirmed_at
       FROM plan_dispatch_attempts d
       LEFT JOIN agents a ON a.id = d.target_agent_id
                          AND a.workspace_id = (SELECT workspace_id FROM plan_work_packages WHERE id = d.package_id)
       LEFT JOIN turn_records t ON t.id = d.confirmed_turn_id
      WHERE d.package_id = ? AND d.package_revision = ?
      ORDER BY d.created_at, d.id`,
    packageId, revision,
  ).map((attempt) => ({
    id: attempt.id,
    state: attempt.state,
    targetAgentId: attempt.target_agent_id,
    targetAgentTitle: attempt.target_agent_title,
    targetSessionId: attempt.target_session_id ?? attempt.confirmed_session_id,
    orchestrationId: attempt.orchestration_id,
    confirmedTurnId: attempt.confirmed_turn_id,
    createdAt: attempt.created_at,
    confirmedAt: attempt.confirmed_at,
  }));
}

function gateAttempts(packageId: string, revision: number): PlanLedgerGateAttempt[] {
  return rows<{
    id: string; gate_key: string; gate_revision: number; attempt_no: number;
    outcome: PlanLedgerGateAttempt['outcome']; finalization_id: string | null;
    witness_agent_id: string | null; witness_session_id: string | null;
    witness_turn_id: string | null; evidence_json: string | null;
    decided_at: number | null; created_at: number;
  }>(
    `SELECT id, gate_key, gate_revision, attempt_no, outcome, finalization_id,
            witness_agent_id, witness_session_id, witness_turn_id, evidence_json,
            decided_at, created_at
       FROM plan_package_gate_attempts
      WHERE package_id = ? AND package_revision = ?
      ORDER BY created_at, id`,
    packageId, revision,
  ).map((gate) => ({
    id: gate.id,
    gateKey: gate.gate_key,
    gateRevision: gate.gate_revision,
    attemptNo: gate.attempt_no,
    outcome: gate.outcome,
    finalizationId: gate.finalization_id,
    witnessAgentId: gate.witness_agent_id,
    witnessSessionId: gate.witness_session_id,
    witnessTurnId: gate.witness_turn_id,
    evidence: parseJson(gate.evidence_json),
    decidedAt: gate.decided_at,
    createdAt: gate.created_at,
  }));
}

function commitChain(packageId: string, revision: number): PlanLedgerCommit[] {
  const links = rows<{
    gate_attempt_id: string; repository_key: string; commit_oid: string; linked_at: number;
    parent_oid: string | null; observed_at: number | null; source: string | null;
  }>(
    `SELECT l.gate_attempt_id, l.repository_key, l.commit_oid, l.created_at AS linked_at,
            c.parent_oid, c.observed_at, c.source
       FROM plan_package_gate_commit_links l
       JOIN plan_package_gate_attempts g ON g.id = l.gate_attempt_id
       LEFT JOIN commit_records c ON c.repository_key = l.repository_key
                                 AND c.commit_oid = l.commit_oid
      WHERE g.package_id = ? AND g.package_revision = ?
      ORDER BY l.created_at, COALESCE(c.observed_at, l.created_at), l.repository_key, l.commit_oid,
               l.gate_attempt_id`,
    packageId, revision,
  );
  const projected = new Map<string, PlanLedgerCommit>();
  for (const link of links) {
    const key = `${link.repository_key}\0${link.commit_oid}`;
    const existing = projected.get(key);
    if (existing) {
      if (!existing.gateAttemptIds.includes(link.gate_attempt_id)) {
        existing.gateAttemptIds.push(link.gate_attempt_id);
      }
      continue;
    }
    projected.set(key, {
      repositoryKey: link.repository_key,
      commitOid: link.commit_oid,
      parentOid: link.parent_oid,
      observedAt: link.observed_at,
      source: link.source,
      firstLinkedAt: link.linked_at,
      gateAttemptIds: [link.gate_attempt_id],
    });
  }
  return [...projected.values()];
}

function deploymentProjection(packageId: string, revision: number): {
  events: PlanLedgerDeploymentEvent[];
  state: PlanLedgerPackageProjection['deploymentState'];
} {
  const source = rows<{
    id: string; environment: string; state: PlanLedgerDeploymentEvent['state'];
    repository_key: string | null; commit_oid: string | null;
    witness_agent_id: string | null; witness_session_id: string | null;
    detail_json: string | null; occurred_at: number;
  }>(
    `SELECT id, environment, state, repository_key, commit_oid, witness_agent_id,
            witness_session_id, detail_json, occurred_at
       FROM plan_package_deployment_events
      WHERE package_id = ? AND package_revision = ?
      ORDER BY occurred_at, id`,
    packageId, revision,
  );
  const latest = new Map<string, string>();
  for (const event of source) latest.set(event.environment, event.id);
  const events = source.map((event): PlanLedgerDeploymentEvent => ({
    id: event.id,
    environment: event.environment,
    state: event.state,
    repositoryKey: event.repository_key,
    commitOid: event.commit_oid,
    witnessAgentId: event.witness_agent_id,
    witnessSessionId: event.witness_session_id,
    detail: parseJson(event.detail_json),
    occurredAt: event.occurred_at,
    current: latest.get(event.environment) === event.id,
  }));
  return {
    events,
    state: events.filter((event) => event.current)
      .sort((a, b) => a.environment.localeCompare(b.environment))
      .map((event) => ({ environment: event.environment, state: event.state })),
  };
}

function stateHistory(packageId: string): PlanLedgerStateEvent[] {
  return rows<{
    id: string; from_state: string; to_state: string; actor: string;
    reason: string | null; ts: number;
  }>(
    `SELECT id, from_state, to_state, actor, reason, ts
       FROM plan_wp_lifecycle_events
      WHERE package_id = ? ORDER BY ts, id`,
    packageId,
  ).map((event) => ({
    id: event.id,
    fromState: event.from_state,
    toState: event.to_state,
    actor: event.actor,
    reason: event.reason,
    occurredAt: event.ts,
  }));
}

/** Render all execution facets for one plan from the live SQLite connection only. */
export function renderPlanFromLedger(planId: string): PlanLedgerProjection | null {
  if (typeof planId !== 'string' || planId === '') return null;
  const plan = row<PlanRow>(
    `SELECT p.id AS plan_id, p.workspace_id, p.artifact_id, p.source_proposal_id,
            p.run_state, p.responsible_supervisor_id,
            proposal.id AS source_join_id, proposal.artifact_id AS source_artifact_id,
            proposal.title AS source_title, proposal.state AS source_state
       FROM plans p
       LEFT JOIN proposals proposal ON proposal.id = p.source_proposal_id
                                   AND proposal.workspace_id = p.workspace_id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
    planId,
  );
  if (!plan) return null;

  const packages = rows<PackageRow>(
    `SELECT wp.id AS package_id, wp.title, wp.acceptance_condition, wp.state,
            wp.assignee_agent_id, wp.revision, wp.projection_status, wp.intent_id,
            intent.id AS intent_join_id, intent.kind AS intent_kind,
            intent.status AS intent_status, intent.reason AS intent_reason,
            intent.integration_note
       FROM plan_work_packages wp
       LEFT JOIN plan_work_package_layout layout ON layout.package_id = wp.id
       LEFT JOIN plan_intents intent ON intent.plan_id = wp.plan_id
                                    AND intent.intent_id = wp.intent_id
                                    AND intent.workspace_id = wp.workspace_id
                                    AND intent.plan_artifact_id = ?
      WHERE wp.plan_id = ? AND wp.workspace_id = ?
      ORDER BY (layout.sort_order IS NULL), layout.sort_order, wp.created_at, wp.id`,
    plan.artifact_id, plan.plan_id, plan.workspace_id,
  ).map((pkg): PlanLedgerPackageProjection => {
    const deployment = deploymentProjection(pkg.package_id, pkg.revision);
    return {
      id: pkg.package_id,
      title: pkg.title,
      acceptanceCondition: pkg.acceptance_condition,
      state: pkg.state,
      revision: pkg.revision,
      assigneeAgentId: pkg.assignee_agent_id,
      bindingState: deriveBindingState(plan, pkg),
      intent: projectIntent(pkg),
      dispatchAttempts: dispatchAttempts(pkg.package_id, pkg.revision),
      gateAttempts: gateAttempts(pkg.package_id, pkg.revision),
      commitChain: commitChain(pkg.package_id, pkg.revision),
      deploymentEvents: deployment.events,
      deploymentState: deployment.state,
      stateHistory: stateHistory(pkg.package_id),
    };
  });

  return {
    planId: plan.plan_id,
    workspaceId: plan.workspace_id,
    planArtifactId: plan.artifact_id,
    runState: plan.run_state,
    responsibleSupervisorId: plan.responsible_supervisor_id,
    sourceProposal: plan.source_join_id === null ? null : {
      id: plan.source_join_id,
      artifactId: plan.source_artifact_id,
      title: plan.source_title,
      state: plan.source_state ?? 'unknown',
    },
    packages,
  };
}
