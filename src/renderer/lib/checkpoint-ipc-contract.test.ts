import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IpcApi } from '../../shared/types';
import { CHECKPOINT_CHANNELS } from '../../shared/types';

// WP-G2.2 — contract coverage for the human checkpoint IPC channels. Two failure
// modes, both of which pass every pure unit test and both of which surface in the
// app as one symptom (the recovery UI silently does nothing):
//
//   1. SHAPE drift — preload stops satisfying `IpcApi['checkpoints']`. Caught at
//      typecheck by the witness below (preload declares `const api: IpcApi`, so a
//      missing/mis-typed member fails `npm run build`).
//   2. CHANNEL-NAME drift — preload invokes a channel main never registers (or vice
//      versa). TypeScript cannot see this (string literals in different files), so
//      the channel strings are compared across preload + the main registrar +
//      CHECKPOINT_CHANNELS directly.
//
// A full Electron E2E suite is an explicit non-goal; this is the cheap coverage
// that keeps the non-goal safe (mirrors continuation-ipc-contract.test.ts).

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/** Typecheck-only: a value of this type must be assignable to the whole
 *  `checkpoints` sub-API. If any signature drifts, `npm run build` fails here. */
type CheckpointApi = IpcApi['checkpoints'];

const CONTRACT_WITNESS: CheckpointApi = {
  list: async (workspaceId) => ({ workspaceId, turns: [] }),
  diff: async (workspaceId, turnId) => ({
    workspaceId,
    turnId,
    witnessed: { available: false, reason: null, label: '', text: null },
    window: { available: false, reason: null, label: '', text: null },
  }),
  preview: async (_workspaceId, turnId) => ({
    available: false, reason: null, turnId, witnessedSet: [], tokens: {},
    validatedPaths: [], rejectedPaths: [], contention: [],
  }),
  restore: async (req) => ({
    status: 'failed', operationId: '', kind: 'restore_paths', preRef: null, preOid: null,
    requestedPaths: req.paths, completedPaths: [], rejectedPaths: [], failures: [],
    contention: [], failureReason: null,
  }),
  revert: async () => ({
    status: 'failed', operationId: '', kind: 'revert_turn', preRef: null, preOid: null,
    requestedPaths: [], completedPaths: [], rejectedPaths: [], failures: [],
    contention: [], failureReason: null,
  }),
};

describe('checkpoint IPC contract (WP-G2.2)', () => {
  it('the checkpoints API members are part of IpcApi with the expected shapes', () => {
    expect(typeof CONTRACT_WITNESS.list).toBe('function');
    expect(typeof CONTRACT_WITNESS.diff).toBe('function');
    expect(typeof CONTRACT_WITNESS.preview).toBe('function');
    expect(typeof CONTRACT_WITNESS.restore).toBe('function');
    expect(typeof CONTRACT_WITNESS.revert).toBe('function');
  });

  it('preload declares itself as IpcApi, so a missing member cannot compile', () => {
    expect(read('src/preload/index.ts')).toMatch(/const api:\s*IpcApi\s*=/);
  });

  it('every channel preload invokes is a channel the main registrar handles', () => {
    const preload = read('src/preload/index.ts');
    const registrar = read('src/main/git-checkpoints/checkpoint-ipc.ts');
    for (const ch of Object.values(CHECKPOINT_CHANNELS)) {
      // preload invokes it (via the CHECKPOINT_CHANNELS.<key> reference, resolved
      // to the literal in the const), and the registrar handles the same key.
      const key = Object.entries(CHECKPOINT_CHANNELS).find(([, v]) => v === ch)![0];
      expect(preload).toContain(`CHECKPOINT_CHANNELS.${key}`);
      expect(registrar).toContain(`CHECKPOINT_CHANNELS.${key}`);
      expect(ch.startsWith('checkpoint:')).toBe(true);
    }
  });

  it('preload routes checkpoint IPC through ipcRenderer.invoke (request/response, not fire-and-forget)', () => {
    const preload = read('src/preload/index.ts');
    for (const key of Object.keys(CHECKPOINT_CHANNELS)) {
      expect(preload).toContain(`ipcRenderer.invoke(CHECKPOINT_CHANNELS.${key}`);
    }
  });
});
