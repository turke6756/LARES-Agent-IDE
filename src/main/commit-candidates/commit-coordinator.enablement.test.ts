// Save-card SC-WP-4K — release enablement gate.
//
// This test deliberately drives the injected flag seam in both directions. It
// must remain valid after the production constant is enabled.

import assert from 'node:assert/strict';

import { COMMIT_COORDINATOR_CHANNEL } from '../../shared/types';
import { registerCommitCoordinatorIpc } from './commit-coordinator-ipc';
import type { IpcLike } from './save-card-ipc';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpc implements IpcLike {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, listener: Handler): void {
    this.handlers.set(channel, listener);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler({}, ...args);
  }
}

const request = {
  candidateId: 'candidate-1',
  tokenId: 'token-1',
  message: 'Save it',
};

async function run(): Promise<void> {
  const ipc = new FakeIpc();
  let enabled = false;
  let routeReads = 0;

  registerCommitCoordinatorIpc(ipc, () => {
    routeReads++;
    return {
      coordinator: {
        commit: async () => ({ kind: 'token-unresolved' as const }),
      },
      resolveCandidateToken: () => null,
      locateRepository: () => ({ repoRoot: 'C:\\repo' }),
    };
  }, () => enabled);

  await assert.rejects(
    () => ipc.invoke(COMMIT_COORDINATOR_CHANNEL, request),
    (error: unknown) => error instanceof Error
      && error.message.includes('disabled')
      && (error as Error & { code?: string }).code === 'commit-coordinator-disabled',
  );
  assert.equal(routeReads, 0, 'disabled direct IPC must stop before route resolution');

  enabled = true;
  assert.deepEqual(
    await ipc.invoke(COMMIT_COORDINATOR_CHANNEL, request),
    {
      kind: 'token-unresolved',
      refusal: {
        stage: 'token-consume', code: 'token-unresolved-or-expired',
        message: 'Token-consume stage refused because the candidate token is unresolved or expired.',
      },
    },
  );
  assert.equal(routeReads, 1, 'the same direct IPC route is reachable through the enabled seam');
}

run().then(
  () => console.log('commit-coordinator enablement gate: ok'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
