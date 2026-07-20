import type { Agent, AgentStatus } from '../../../shared/types';

/**
 * Idle-agent lifecycle §B3 — every status write now goes through
 * `applyStatusTransition`, which opens a DB transaction. Main-process test
 * harnesses that patch `updateAgentStatus` onto an in-memory agent map must
 * therefore ALSO patch the transition writer, or the supervisor's status writes
 * reach the real (never-opened) better-sqlite3 handle and throw.
 *
 * The shim delegates to whatever `updateAgentStatus` fake is already installed
 * and reports a prior status read from the harness's `getAgent` fake when it
 * has one, so `statusChanged.fromStatus` stays meaningful in tests.
 *
 * Callers must include `'applyStatusTransition'` in their save/restore key list.
 */
export function patchApplyStatusTransition(db: Record<string, unknown>): void {
  const update = db.updateAgentStatus as (id: string, status: AgentStatus) => void;
  const get = db.getAgent as ((id: string) => Agent | null | undefined) | undefined;
  db.applyStatusTransition = (id: string, status: AgentStatus) => {
    const prior = typeof get === 'function' ? get(id)?.status : undefined;
    update(id, status);
    return { prior: prior ?? status, current: status };
  };
}
